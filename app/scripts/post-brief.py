#!/usr/bin/env python3
"""Post a brief and suggestions to the app via D1."""

import sys
import json
import subprocess
import tempfile
import os
import secrets
from datetime import datetime, timezone

def quote(s):
    """Safely quote a string for SQL: reject NUL bytes, double single quotes."""
    if s is None:
        return 'NULL'
    if '\x00' in s:
        raise ValueError('NUL byte in string')
    return "'" + s.replace("'", "''") + "'"

def similar(col, title):
    """SQL: column and title match ignoring case, or one starts with the other's first 18 chars."""
    t = quote(title.lower())
    head = quote(title.lower()[:18])
    return (f"(lower({col}) = {t} OR instr({t}, substr(lower({col}), 1, 18)) = 1 "
            f"OR instr(lower({col}), {head}) = 1)")

def validate_brief(brief):
    """Validate brief fields."""
    if not isinstance(brief, dict):
        raise ValueError('Brief must be a dict')

    date = brief.get('date')
    body_md = brief.get('body_md')

    if not date or not isinstance(date, str) or not len(date) == 10:
        raise ValueError(f'Invalid date: {date}')

    if not body_md or not isinstance(body_md, str) or len(body_md) > 20000:
        raise ValueError(f'Invalid body_md (max 20000 chars)')

    return date, body_md

def validate_suggestion(sugg):
    """Validate suggestion fields."""
    if not isinstance(sugg, dict):
        raise ValueError('Suggestion must be a dict')

    title = sugg.get('title')
    if not title or not isinstance(title, str) or len(title) > 200:
        raise ValueError(f'Invalid title: {title}')

    due_date = sugg.get('due_date')
    if due_date and (not isinstance(due_date, str) or not len(due_date) == 10):
        raise ValueError(f'Invalid due_date: {due_date}')

    priority = sugg.get('priority')
    if priority and priority not in ('P0', 'P1', 'P2', 'P3'):
        raise ValueError(f'Invalid priority: {priority}')

    list_name = sugg.get('list', 'Tasks')
    if list_name not in ('Tasks', 'Birthdays'):
        raise ValueError(f'Invalid list: {list_name}')

    recurrence = sugg.get('recurrence')
    if recurrence and recurrence not in ('daily', 'weekdays', 'weekly', 'monthly', 'yearly'):
        raise ValueError(f'Invalid recurrence: {recurrence}')

    source = sugg.get('source')
    if source and source not in ('Gmail', 'Calendar', 'Messages', 'Messenger', 'WhatsApp'):
        raise ValueError(f'Invalid source: {source}')

    source_detail = sugg.get('source_detail')
    if source_detail and len(source_detail) > 300:
        raise ValueError(f'Invalid source_detail (max 300 chars)')

    area = sugg.get('area')
    if area and area not in ('kids', 'family', 'health', 'work', 'venture', 'finance', 'house'):
        raise ValueError(f'Invalid area: {area}')

    return title, due_date, priority, list_name, recurrence, source, source_detail, area

def main():
    if len(sys.argv) < 2:
        print('Usage: python3 post-brief.py brief.json [--remote]')
        sys.exit(1)

    brief_file = sys.argv[1]
    remote = '--remote' in sys.argv

    if not os.path.exists(brief_file):
        print(f'File not found: {brief_file}')
        sys.exit(1)

    with open(brief_file) as f:
        data = json.load(f)

    date, body_md = validate_brief(data)
    suggestions = data.get('suggestions', [])

    # Build SQL
    sql_lines = []
    sql_lines.append(f'DELETE FROM briefs WHERE tenant_id = {quote("owner")} AND date = {quote(date)};')
    sql_lines.append(f'DELETE FROM suggestions WHERE tenant_id = {quote("owner")} AND brief_date = {quote(date)} AND status = {quote("pending")};')

    # Insert brief
    brief_id = 'b-' + secrets.token_hex(4)
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    sql_lines.append(
        f'INSERT INTO briefs (id, tenant_id, date, body_md, created_at) VALUES '
        f'({quote(brief_id)}, {quote("owner")}, {quote(date)}, {quote(body_md)}, {quote(now)});'
    )

    # Insert suggestions (drop invalid ones with warning)
    valid_count = 0
    for sugg in suggestions:
        try:
            title, due_date, priority, list_name, recurrence, source, source_detail, area = validate_suggestion(sugg)
            sugg_id = 's-' + secrets.token_hex(4)
            sql_lines.append(
                f'INSERT INTO suggestions (id, tenant_id, brief_date, title, due_date, priority, list, recurrence, source, source_detail, area, status, created_at) SELECT '
                f'{quote(sugg_id)}, {quote("owner")}, {quote(date)}, {quote(title)}, '
                f'{quote(due_date) if due_date else "NULL"}, {quote(priority) if priority else "NULL"}, {quote(list_name)}, '
                f'{quote(recurrence) if recurrence else "NULL"}, {quote(source) if source else "NULL"}, '
                f'{quote(source_detail) if source_detail else "NULL"}, {quote(area) if area else "NULL"}, {quote("pending")}, {quote(now)} '
                # Dedupe guard: skip if it matches an open task, or a suggestion decided in the last 14 days
                f'WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.completed_at IS NULL AND {similar("t.title", title)}) '
                f'AND NOT EXISTS (SELECT 1 FROM suggestions x WHERE x.status != {quote("pending")} AND x.created_at >= datetime({quote("now")}, {quote("-14 day")}) AND {similar("x.title", title)});'
            )
            valid_count += 1
        except ValueError as e:
            print(f'Warning: Skipping invalid suggestion: {e}')

    # Write to temp file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.sql', delete=False) as f:
        f.write('\n'.join(sql_lines))
        temp_sql_file = f.name

    try:
        # Run wrangler d1 execute
        cmd = ['npx', 'wrangler', 'd1', 'execute', 'my-os', '--file', temp_sql_file]
        if remote:
            cmd.insert(4, '--remote')
        else:
            cmd.insert(4, '--local')

        result = subprocess.run(cmd, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              capture_output=True, text=True)

        if result.returncode != 0:
            print(f'Error: {result.stderr}')
            sys.exit(1)

        print(f'Brief {date}: 1 brief, {valid_count} suggestion(s)')
    finally:
        os.unlink(temp_sql_file)

if __name__ == '__main__':
    main()
