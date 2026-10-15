package com.example.myos;

import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Toast;

/**
 * The add-task widget's dialog: keyboard up at once, type, Add. The to-do goes to Inbox through the device-token
 * queue, so it works with the app closed and offline. No date or area: the CoS triages Inbox.
 */
public class QuickAddActivity extends Activity {
    private EditText input;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.quick_add);
        getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE
            | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        input = findViewById(R.id.qa_input);
        Button add = findViewById(R.id.qa_add);
        findViewById(R.id.qa_cancel).setOnClickListener(v -> finish());
        add.setOnClickListener(v -> submit());
        input.setOnEditorActionListener((v, actionId, event) -> {
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER && event.getAction() == KeyEvent.ACTION_DOWN;
            if (actionId == EditorInfo.IME_ACTION_DONE || enter) { submit(); return true; }
            return false;
        });
        input.requestFocus();
    }

    private void submit() {
        String title = input.getText().toString().trim();
        if (title.isEmpty()) { finish(); return; }
        TaskQueue.add(this, title.length() > 200 ? title.substring(0, 200) : title);
        CreateTaskWorker.enqueue(this, true);
        AddTaskWidget.render(this);
        WidgetActionActivity.tick(this);
        Toast.makeText(this, "Added to Inbox", Toast.LENGTH_SHORT).show();
        finish();
    }
}
