// my-os v1 UI, end to end: real Worker + SQLite (scripts/dev-v1.mjs) driven by headless Chromium.
// Every interaction is checked against the database. Needs Playwright (preinstalled globally in the build container);
// skips with a message when it isn't available.  Run: node scripts/test-v1-ui.mjs
import assert from 'assert/strict';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { startServer } from './dev-v1.mjs';

let chromium;
try { chromium = createRequire(execSync('npm root -g').toString().trim() + '/')('playwright').chromium; }
catch (e) { console.log('test-v1-ui: skipped (playwright not installed)'); process.exit(0); }

const { server, sqlite, url } = await startServer({ port: 0 });
const browser = await chromium.launch();
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const row = (id) => sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
const laDate = (o = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(Date.now() + o * 86400000));
async function until(fn, msg, ms = 6000) {
  const t0 = Date.now();
  for (;;) { let v; try { v = fn(); } catch (e) { v = false; } if (v) { checks++; return v; } if (Date.now() - t0 > ms) throw new Error('timeout: ' + msg); await new Promise(r => setTimeout(r, 100)); }
}
const errors = [];
async function open(viewport, motion = false) {
  // reduced motion: the app skips View Transitions, so each click updates the DOM synchronously (one test below runs with motion)
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/Los_Angeles', hasTouch: viewport.width < 800, reducedMotion: motion ? 'no-preference' : 'reduce' });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url + '/login');
  await page.fill('input[name=passphrase]', 'dev');
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit], input[type=submit]')]);
  return { ctx, page };
}
const nav = async (page, r) => { await page.evaluate(r => { location.hash = ''; history.replaceState(null, '', '#' + r); location.reload(); }, r); await page.waitForSelector('#view .list-title, #view .nav-i'); };
const rowSel = (title) => `#view li.row:has(.tx:text-is("${title}"))`;

try {
  // ---------------- phone ----------------
  const { ctx, page } = await open({ width: 390, height: 844 });
  await nav(page, 'today');
  eq(await page.textContent('#view .list-title'), 'Today');
  ok(await page.isVisible('text=Picture day') && await page.isVisible('text=Lunch'), 'events');
  ok(await page.isVisible(`${rowSel('Trash bins out')}`) && await page.isVisible('.sec-head:has-text("This Evening")'), 'This Evening');
  ok(await page.isVisible(`${rowSel('Take vitamins')}`), 'overdue repeat shows in Today');

  // complete (lingers, then saved), restore from the Logbook
  await page.click(`${rowSel('Call the clinic to book')} .cb`);
  ok(await page.isVisible(`${rowSel('Call the clinic to book')}.done`), 'linger');
  await until(() => row('t-call').completed_at, 'completed saved');
  await page.waitForSelector(rowSel('Call the clinic to book'), { state: 'detached' });
  // tap twice = no completion
  await page.click(`${rowSel('Expense report')} .cb`); await page.click(`${rowSel('Expense report')} .cb`);
  await page.waitForTimeout(2300); eq(row('t-expense').completed_at, null, 'second tap undoes');
  await nav(page, 'logbook');
  ok(await page.isVisible('text=Call the clinic to book') && await page.isVisible('text=Paid the water bill'));
  await page.click('.lb:has-text("Call the clinic to book") .cb');
  await until(() => row('t-call').completed_at === null, 'restored from Logbook');

  // repeating: completing moves it to the next date; a done copy shows in the Logbook
  await nav(page, 'today');
  await page.click(`${rowSel('Trash bins out')} .cb`);
  await until(() => row('t-bins').due_date === laDate(7), 'weekly repeat advanced');
  await until(() => one("SELECT COUNT(*) AS n FROM completions WHERE task_id = 't-bins'").n === 1, 'completion logged');
  await page.waitForSelector(rowSel('Trash bins out'), { state: 'detached' });
  await nav(page, 'logbook'); ok(await page.isVisible('.lb:has-text("Trash bins out")'), 'repeat completion in Logbook');

  // + in Today: new to-do dated today; empty ones are discarded
  await nav(page, 'today');
  await page.click('#plus');
  await page.keyboard.type('Book the dentist');
  await page.click('#view .list-title');
  const newId = (await until(() => one("SELECT id FROM tasks WHERE title = 'Book the dentist'"), 'created')).id;
  eq([row(newId).due_date, row(newId).created_via], [laDate(0), 'app']);
  await page.click('#plus'); await page.click('#view .list-title');
  await page.waitForTimeout(900); eq(one("SELECT COUNT(*) AS n FROM tasks WHERE title = ''").n, 0, 'empty draft discarded');

  // detail card: flag, notes, When (typed) + Undo, checklist
  await page.click(`${rowSel('Book the dentist')} .row-main`);
  await page.waitForSelector('.row.open #notes');
  await page.click('#d-flag'); await until(() => row(newId).flagged === 1, 'flag saved');
  await page.fill('#notes', 'Ask about the cleaning'); await until(() => row(newId).notes === 'Ask about the cleaning', 'notes saved');
  await page.click('#d-check'); await page.fill('#ck-add', 'Find the insurance card'); await page.press('#ck-add', 'Enter');
  await until(() => one('SELECT COUNT(*) AS n FROM checklist_items WHERE task_id = ?', newId).n === 1, 'checklist saved');
  await page.click('#d-when'); await page.fill('#when-input', 'tomorrow'); await page.press('#when-input', 'Enter');
  await until(() => row(newId).due_date === laDate(1), 'When → tomorrow');
  await page.click('#toast-undo'); await until(() => row(newId).due_date === laDate(0), 'undo puts it back');
  // When picker: Someday and This Evening
  await page.click(`${rowSel('Book the dentist')} .row-main`); await page.click('#d-when'); await page.click('.pop [data-w="evening"]');
  await until(() => row(newId).evening === 1, 'This Evening');
  ok(await page.isVisible('.sec-head:has-text("This Evening") + ul .tx:text-is("Book the dentist")'), 'shown under This Evening');

  // Move to a project, then Delete → Trash → Restore
  await page.click(`${rowSel('Book the dentist')} .row-main`); await page.click('#d-move'); await page.click('.pop [data-m="project:p-garden"]');
  await until(() => row(newId).project_id === 'p-garden' && row(newId).area_id === 'a-home', 'moved to project');
  await page.click(`${rowSel('Book the dentist')} .row-main`); await page.click('#d-more'); await page.click('.pop [data-a="del"]');
  await until(() => row(newId).trashed_at, 'trashed');
  await nav(page, 'trash'); await page.click(`[data-restore="${newId}"]`);
  await until(() => row(newId).trashed_at === null, 'restored from Trash');

  // Cancel a one-off (••• → Cancel) and undo
  await nav(page, 'today');
  await page.click(`${rowSel('Expense report')} .row-main`); await page.click('#d-more'); await page.click('.pop [data-a="cancel"]');
  await until(() => row('t-expense').dropped_at, 'canceled');
  await page.click('#toast-undo'); await until(() => row('t-expense').dropped_at === null, 'cancel undone');

  // Inbox: suggestion accept → undo → dismiss; plain quick-add goes to Inbox
  await nav(page, 'inbox');
  ok(await page.isVisible('.sugg:has-text("Get a flu shot")') && await page.isVisible('text=The clinic says it is due this month.'));
  await page.click('.sugg .cb'); await until(() => row('t-sug').suggestion_state === 'accepted', 'accepted');
  await page.click('#toast-undo'); await until(() => row('t-sug').suggestion_state === 'pending', 'accept undone');
  await page.click('.sugg .row-main'); await page.click('#s-dismiss');
  await until(() => row('t-sug').suggestion_state === 'dismissed', 'dismissed');
  ok(!(await page.isVisible('.sugg')), 'gone from Inbox');
  await page.click('#plus'); await page.keyboard.type('Return library books'); await page.click('#view .list-title');
  await until(() => { const r = one("SELECT * FROM tasks WHERE title = 'Return library books'"); return r && r.inbox === 1 && r.due_date === null; }, 'Inbox quick-add');

  // Claude list: drop → undo
  await nav(page, 'claude');
  await page.click('.cl:has-text("Research school options") .row-main'); await page.click('#c-drop');
  await until(() => row('t-cl').dropped_at, 'dropped');
  await page.click('#toast-undo'); await until(() => row('t-cl').dropped_at === null, 'drop undone');

  // Project page: headings, checklist count; Lists → New Project
  await nav(page, 'project:p-school');
  ok(await page.isVisible('.heading:has-text("This month")') && await page.isVisible(rowSel('Sign and return the plan')));
  // drag + to the far left of the first row: a new heading that takes the rows from there down (to the old heading)
  { const plus = await page.locator('#plus').boundingBox(), r = await page.locator(`${rowSel('Start home reading plan')} .row-main`).boundingBox();
    await page.mouse.move(plus.x + 20, plus.y + 20); await page.mouse.down();
    await page.mouse.move(plus.x + 5, plus.y - 20, { steps: 3 });
    await page.mouse.move(r.x + 8, r.y + 6, { steps: 10 }); await page.mouse.up(); }
  const h = await until(() => one("SELECT * FROM headings WHERE project_id = 'p-school' AND title = 'New Heading'"), 'heading created');
  await until(() => row('t-read').heading_id === h.id, 'row moved under the new heading');
  eq(row('t-sign').heading_id, 'h-month', 'rows under another heading stay');
  await until(() => one("SELECT sort FROM headings WHERE id = ?", h.id).sort < one("SELECT sort FROM headings WHERE id = 'h-month'").sort, 'new heading sorted first');
  await page.click(`[data-hid="${h.id}"]`); await page.keyboard.press('Control+A'); await page.keyboard.type('Reading');
  await until(() => one("SELECT title FROM headings WHERE id = ?", h.id).title === 'Reading', 'heading renamed');
  await nav(page, 'home');
  await page.click('#plus'); await page.click('.pop [data-n="project"]'); await page.waitForSelector('#title-edit:focus');
  await page.keyboard.type('Plan the party');
  await until(() => one("SELECT * FROM projects WHERE title = 'Plan the party'"), 'project created');
  await page.click('#plus'); await page.keyboard.type('Send invites'); await page.click('#view .list-title');
  await until(() => { const r = one("SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.title = 'Send invites' AND p.title = 'Plan the party'"); return r; }, 'to-do in the new project');

  // Upcoming shows dated items and events; Someday; Brief clears its dot; Settings + feedback
  await nav(page, 'upcoming'); ok(await page.isVisible('text=Soccer game') && await page.isVisible(rowSel('Sign and return the plan')), 'Upcoming');
  await nav(page, 'someday'); ok(await page.isVisible(rowSel('Choose new lights')), 'Someday');
  await nav(page, 'home'); ok(await page.isVisible('#view [data-r="brief"] .dot'), 'brief dot');
  await page.click('#view [data-r="brief"]'); await page.waitForSelector('.brief-title');
  ok(await page.isVisible('.brief-title:text-is("Monday brief")') && await page.isVisible('text=The one thing today: call the clinic to book.'), 'brief markdown');
  await page.click('#back'); await page.waitForSelector('#view [data-r="brief"]');
  ok(!(await page.isVisible('#view [data-r="brief"] .dot')), 'dot clears after reading');
  await nav(page, 'brief'); await page.waitForSelector('#brief-updated');
  ok(/^Updated \d{1,2}:\d\d [AP]M$/.test(await page.textContent('#brief-updated')) && !(await page.isVisible('.brief-meta .health.stale')), 'fresh: "Updated 5:30 AM", green');
  const bAt = one("SELECT created_at FROM briefs WHERE id = 'b-1'").created_at;
  sqlite.prepare("UPDATE briefs SET created_at = ? WHERE id = 'b-1'").run(new Date(Date.now() - 24 * 3600000).toISOString());
  await nav(page, 'brief'); await page.waitForSelector('#brief-updated');
  ok(/^Updated yesterday \d{1,2}:\d\d [AP]M$/.test(await page.textContent('#brief-updated')) && await page.isVisible('.brief-meta .health.stale'), 'yesterday\'s brief: "Updated yesterday …", gray');
  sqlite.prepare("UPDATE briefs SET created_at = ? WHERE id = 'b-1'").run(bAt); await nav(page, 'brief');

  // repeat picker: set "every week" on an undated to-do (starts today), complete it, it moves a week on
  await nav(page, 'someday');
  await page.click(`${rowSel('Choose new lights')} .row-main`); await page.click('#d-more'); await page.click('.pop [data-a="repeat"]');
  await page.waitForSelector('.pop [data-rp="weekly"]'); await page.click('.pop [data-rp="weekly"]');
  await until(() => row('t-lights').recurrence === 'weekly' && row('t-lights').due_date === laDate(0), 'repeat set; starts today');
  await nav(page, 'today'); ok(await page.isVisible(rowSel('Choose new lights')), 'now in Today');
  await page.click(`${rowSel('Choose new lights')} .cb`);
  await until(() => row('t-lights').due_date === laDate(7), 'weekly repeat moves a week on');
  await nav(page, 'upcoming'); await page.click(`${rowSel('Choose new lights')} .row-main`);
  ok(await page.isVisible('.dline:has-text("Repeats weekly on")'), 'repeat line in the card');
  await page.click('#d-more'); await page.click('.pop [data-a="repeat"]'); await page.waitForSelector('.pop [data-rp="never"]');
  await page.fill('#rp-end', '3 times'); await page.click('.pop [data-rp="a-2w"]');
  await until(() => JSON.parse(row('t-lights').repeat_rule || '{}').mode === 'after' && JSON.parse(row('t-lights').repeat_rule).end?.after === 3, 'after-completion rule with an end');

  // timer: start in the card, bar on top, stop from the bar; completing a timed to-do logs its time
  await nav(page, 'today');
  await page.click(`${rowSel('Take vitamins')} .row-main`); await page.click('#timer-btn');
  await until(() => one("SELECT * FROM time_entries WHERE task_id = 't-vitamins' AND stopped_at IS NULL"), 'timer started');
  ok(await page.isVisible('#timerbar:has-text("Take vitamins")'), 'running bar');
  await page.click('#tb-stop'); await until(() => one("SELECT * FROM time_entries WHERE task_id = 't-vitamins' AND stopped_at IS NOT NULL"), 'timer stopped');
  ok(await page.isHidden('#timerbar'));
  await page.click('#view .list-title'); // a tap outside closes the open card
  await page.click(`${rowSel('Expense report')} .row-main`); await page.click('#timer-btn');
  await until(() => one("SELECT * FROM time_entries WHERE task_id = 't-expense' AND stopped_at IS NULL"), 'second timer');
  await page.click('#view .list-title');
  await page.click(`${rowSel('Expense report')} .cb`);
  await page.waitForSelector('#toast.show:has-text("Expense report · 1m logged")');
  await until(() => row('t-expense').completed_at && one("SELECT stopped_at FROM time_entries WHERE task_id = 't-expense'").stopped_at, 'completed + stopped');
  await nav(page, 'logbook'); ok(await page.isVisible('.lb:has-text("Expense report") .meta:text-is("1m")'), 'time in the Logbook (min 1m once timed)');
  await page.click('.lb:has-text("Expense report") .cb'); await until(() => row('t-expense').completed_at === null, 'restored for the web tests');

  await nav(page, 'settings');
  await page.click('[data-set="freeLines"]');
  eq(await page.evaluate(() => JSON.parse(localStorage.getItem('myos.v1.settings')).freeLines), false, 'setting saved on device');
  await until(() => one("SELECT value FROM settings WHERE key = 'free_lines'")?.value === 'false', 'setting saved on the server');
  await page.selectOption('#set-workEnd', '1020');
  await until(() => one("SELECT value FROM settings WHERE key = 'work_end'")?.value === '1020', 'work schedule saved');
  await page.click('#send-fb'); await page.fill('#fb-note', 'Rows could be taller'); await page.click('.pop [data-send]');
  await until(() => one("SELECT * FROM feedback WHERE note = 'Rows could be taller' AND screen = 'settings'"), 'feedback saved');
  await ctx.close();

  // ---------------- web ----------------
  const w = await open({ width: 1280, height: 860 });
  await nav(w.page, 'today');
  ok(await w.page.isVisible('#side .nav-i[data-r="today"].on'), 'sidebar');
  eq(await w.page.evaluate(() => JSON.parse(localStorage.getItem('myos.v1.settings')).workEnd), 1020, 'another device gets the server settings');
  // drag a row onto the Someday list in the sidebar
  const src = await w.page.locator(`${rowSel('Expense report')} .row-main`).boundingBox();
  const dst = await w.page.locator('#side [data-r="someday"]').boundingBox();
  await w.page.mouse.move(src.x + 60, src.y + src.height / 2); await w.page.mouse.down();
  await w.page.mouse.move(src.x + 80, src.y + src.height / 2 + 10, { steps: 4 });
  await w.page.mouse.move(dst.x + 40, dst.y + dst.height / 2, { steps: 10 }); await w.page.mouse.up();
  await until(() => row('t-expense').start === 'someday' && row('t-expense').due_date === null, 'dragged to Someday');
  // reorder in Today persists today_index
  await nav(w.page, 'today');
  const a = await w.page.locator(`${rowSel('Take vitamins')} .row-main`).boundingBox();
  const b = await w.page.locator(`${rowSel('Call the clinic to book')} .row-main`).boundingBox();
  await w.page.mouse.move(a.x + 60, a.y + a.height / 2); await w.page.mouse.down();
  await w.page.mouse.move(a.x + 70, a.y + a.height / 2 + 10, { steps: 3 });
  await w.page.mouse.move(b.x + 60, b.y + b.height - 4, { steps: 8 }); await w.page.mouse.up();
  await until(() => row('t-vitamins').today_index > row('t-call').today_index, 'reorder saved');
  await nav(w.page, 'today');
  const titles = await w.page.$$eval('#view .row .tx', els => els.map(e => e.textContent));
  ok(titles.indexOf('Call the clinic to book') < titles.indexOf('Take vitamins'), 'order survives reload');
  // Quick Find: typing anywhere opens it; Enter goes to the match
  await w.page.keyboard.type('garden'); await w.page.waitForSelector('#find-ov:not([hidden])');
  await w.page.keyboard.press('Enter'); await w.page.waitForSelector('#view .list-title:has-text("Garden care")');
  ok(true, 'quick find');
  // tap-away on the web: a click on a sidebar link while a card is open only closes the card; a wheel scroll closes it too
  await nav(w.page, 'today');
  await w.page.click(`${rowSel('Take vitamins')} .row-main`); await w.page.waitForSelector('.row.open');
  await w.page.mouse.click(5, 5); // blank corner: nothing focused in the card, so this closes it
  ok(!(await w.page.isVisible('.row.open')), 'click outside closes');
  await w.page.click(`${rowSel('Take vitamins')} .row-main`); await w.page.waitForSelector('.row.open');
  await w.page.click('#side .nav-i[data-r="upcoming"]');
  ok(!(await w.page.isVisible('.row.open')) && await w.page.isVisible('#side .nav-i[data-r="today"].on'), 'the link under the closing click is not followed');
  await w.page.click('#side .nav-i[data-r="upcoming"]'); await w.page.waitForSelector('#side .nav-i[data-r="upcoming"].on'); ok(true, 'the next click follows it');
  await nav(w.page, 'today'); await w.page.addStyleTag({ content: '#view{padding-bottom:3000px}' });
  await w.page.click(`${rowSel('Take vitamins')} .row-main`); await w.page.waitForSelector('.row.open'); await w.page.waitForTimeout(800);
  await w.page.mouse.move(640, 500); await w.page.mouse.wheel(0, 400);
  await w.page.waitForTimeout(300);
  ok(!(await w.page.isVisible('.row.open')), 'wheel scroll closes the card');
  await w.ctx.close();

  // Design note: tapping another row while a card is open only closes the card; a phone held sideways keeps the phone layout
  const fb = await open({ width: 390, height: 844 });
  await nav(fb.page, 'today');
  await fb.page.click(`${rowSel('Call the clinic to book')} .row-main`); await fb.page.waitForSelector('.row.open');
  await fb.page.click(`${rowSel('Take vitamins')} .row-main`);
  ok(!(await fb.page.isVisible('.row.open')), 'tap outside closes the card and opens nothing else');
  await fb.page.click(`${rowSel('Take vitamins')} .row-main`); ok(await fb.page.isVisible('.row.open'), 'the next tap opens normally');
  // typing in the card: the first outside tap only closes the keyboard, the second closes the card, the third acts
  await fb.page.click('.row.open #notes'); ok(await fb.page.evaluate(() => document.activeElement.id === 'notes'), 'typing');
  await fb.page.click(`${rowSel('Call the clinic to book')} .row-main`);
  ok(await fb.page.isVisible('.row.open') && await fb.page.evaluate(() => document.activeElement.id !== 'notes'), 'first tap: keyboard closes, card stays');
  await fb.page.click(`${rowSel('Call the clinic to book')} .row-main`); ok(!(await fb.page.isVisible('.row.open')), 'second tap: card closes, nothing opens');
  await fb.page.click(`${rowSel('Call the clinic to book')} .row-main`); ok(await fb.page.isVisible(`${rowSel('Call the clinic to book')}.open`), 'third tap opens it');
  await fb.page.mouse.click(5, 300);
  // a long press whose row re-renders before the 400 ms timer: no setPointerCapture error, no drag
  await fb.page.click('#view .list-title');
  await fb.page.locator(`${rowSel('Take vitamins')} .row-main`).evaluate(m => { const r = m.getBoundingClientRect();
    m.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: r.left + 40, clientY: r.top + 10 }));
    m.closest('li').replaceWith(m.closest('li').cloneNode(true)); });
  await fb.page.waitForTimeout(500);
  ok(!(await fb.page.isVisible('.drag-ghost')), 'long press on a re-rendered row starts no drag');
  await fb.page.setViewportSize({ width: 900, height: 400 }); await fb.page.waitForTimeout(100);
  ok(!(await fb.page.isVisible('#side .nav-i')), 'landscape phone: no sidebar');
  await fb.ctx.close();

  // Today's event times never wrap (360 / 412 px, text scale 1 and 1.15) and titles line up
  for (const [width, scale] of [[360, 1], [412, 1], [360, 1.15], [412, 1.15]]) {
    const tc = await open({ width, height: 800 });
    await nav(tc.page, 'today');
    if (scale !== 1) await tc.page.addStyleTag({ content: `.ev{font-size:${14 * scale}px}.ev-time{font-size:${13 * scale}px}` });
    await tc.page.$$eval('#view .ev-time > span', ss => { ss[ss.length - 1].textContent = '12:00 PM'; }); // the widest value (seed times are relative)
    const m = await tc.page.$$eval('#view .ev', evs => evs.map(e => { const t = e.querySelector('.ev-time'), s = t.firstElementChild;
      return { oneLine: s.getBoundingClientRect().height < parseFloat(getComputedStyle(t).fontSize) * 2, text: s.textContent, titleX: Math.round(e.querySelector('.ev-title').getBoundingClientRect().left) }; }));
    ok(m.length >= 2, 'events shown');
    ok(m.every(x => x.oneLine), `times on one line at ${width}px x${scale}: ${JSON.stringify(m.map(x => x.text))}`);
    eq(new Set(m.map(x => x.titleX)).size, 1, `titles aligned at ${width}px x${scale}`);
    await tc.ctx.close();
  }

  // area chips: filter Today's to-dos by area (the calendar stays), remembered per view until local midnight
  const ac = await open({ width: 390, height: 844 });
  await nav(ac.page, 'today');
  const chips = await ac.page.$$eval('#view [data-af]', bs => bs.map(b => [b.dataset.af, b.textContent, b.classList.contains('on')]));
  eq(chips[0], ['', 'All', true], 'All first and selected'); ok(chips.length >= 3, 'one chip per area with to-dos today');
  const areaIdOf = id => { const t = row(id); return t.project_id ? one('SELECT area_id FROM projects WHERE id = ?', t.project_id).area_id : t.area_id; };
  const shown = () => ac.page.$$eval('#view li.row[data-id]', ls => ls.map(l => l.dataset.id));
  const allIds = await shown();
  ok(chips.slice(1).every(([id]) => allIds.some(t => areaIdOf(t) === id)) && one('SELECT COUNT(*) AS n FROM areas').n > chips.length - 1, 'areas with nothing today are hidden');
  const [aid, atitle] = chips[1];
  await ac.page.click(`#view [data-af="${aid}"]`);
  const some = await shown(); ok(some.length > 0 && some.length < allIds.length && some.every(t => areaIdOf(t) === aid), 'only ' + atitle);
  ok(await ac.page.isVisible('#view .events'), 'calendar stays');
  await nav(ac.page, 'today'); ok(await ac.page.isVisible(`#view [data-af="${aid}"].on`), 'remembered');
  await nav(ac.page, 'upcoming'); ok(await ac.page.isVisible('#view [data-af=""].on'), 'per view: Upcoming still on All');
  await nav(ac.page, 'today'); await ac.page.click('#view [data-af=""]'); eq((await shown()).length, allIds.length, 'All shows everything again');
  await ac.page.click(`#view [data-af="${aid}"]`);
  await ac.page.evaluate(() => { const v = JSON.parse(localStorage.getItem('myos.v1.areaF')); v.day -= 1; localStorage.setItem('myos.v1.areaF', JSON.stringify(v)); });
  await nav(ac.page, 'today'); ok(await ac.page.isVisible('#view [data-af=""].on'), 'a new day starts on All');
  await ac.ctx.close();

  // with motion: page and card transitions run (View Transitions), navigation and editing still work
  const mo = await open({ width: 390, height: 844 }, true);
  await nav(mo.page, 'home');
  await mo.page.click('#view [data-r="today"]'); await mo.page.waitForFunction(() => document.querySelector('#view .list-title .t')?.textContent === 'Today');
  await mo.page.click(`${rowSel('Call the clinic to book')} .row-main`); await mo.page.waitForSelector('.row.open #notes');
  await mo.page.click('#view .list-title'); await mo.page.waitForSelector('.row.open', { state: 'detached' });
  await mo.page.click('#back'); await mo.page.waitForSelector('#view [data-r="brief"]');
  await mo.page.waitForFunction(() => !document.documentElement.dataset.nav, null, { timeout: 2000 }); ok(true, 'transition state cleaned up');
  // instant launch: with the network down for /state, the last state (this device) still paints
  await mo.page.route('**/api/v1/state', r => r.abort());
  await mo.page.evaluate(() => { location.hash = '#today'; location.reload(); });
  await mo.page.waitForFunction(() => document.querySelector('#view .list-title .t')?.textContent === 'Today');
  ok(await mo.page.isVisible(rowSel('Call the clinic to book')), 'painted from the cached state');
  for (let i = errors.length - 1; i >= 0; i--) if (/ERR_FAILED/.test(errors[i])) errors.splice(i, 1); // the abort above is intentional
  await mo.ctx.close();

  eq(errors, [], 'no page errors');
} finally {
  await browser.close(); server.close();
}
console.log(`test-v1-ui: ${checks} checks passed`);
