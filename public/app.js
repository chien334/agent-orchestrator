const runsNode = document.querySelector("#runs");
const messageNode = document.querySelector("#message");
const overviewNode = document.querySelector("#overview");
const updatedNode = document.querySelector("#updated");
const button = document.querySelector("#refresh");

const labels = {
  queued: "Đang đợi",
  running: "Đang chạy",
  completed: "Hoàn tất",
  failed: "Thất bại",
  blocked: "Cần xác nhận",
  cancelled: "Đã hủy",
};
const node = (tag, className, text) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = String(text);
  return item;
};
const date = (value) =>
  value
    ? new Date(value).toLocaleString("vi-VN", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "Chưa bắt đầu";
const duration = (task) =>
  task.started_at
    ? `${Math.max(0, Math.floor((new Date(task.finished_at ?? Date.now()) - new Date(task.started_at)) / 1000))} giây`
    : "—";
const block = (label, value, full = false, code = false) => {
  const wrapper = node("div", `detail-block${full ? " full" : ""}`);
  wrapper.append(node("span", "detail-label", label));
  const body = node("p", "detail-value");
  body.append(node(code ? "code" : "span", "", value || "—"));
  wrapper.append(body);
  return wrapper;
};

function render(runs) {
  const expanded = new Set(
    [...document.querySelectorAll("details[open]")].map(
      (item) => item.dataset.key,
    ),
  );
  const tasks = runs.flatMap((run) => run.tasks);
  const metrics = [
    ["Tổng tác vụ", tasks.length],
    ["Đang chạy", tasks.filter((task) => task.status === "running").length],
    ["Hoàn tất", tasks.filter((task) => task.status === "completed").length],
    [
      "Cần chú ý",
      tasks.filter((task) => ["failed", "blocked"].includes(task.status))
        .length,
    ],
  ];
  overviewNode.replaceChildren(
    ...metrics.map(([label, count]) => {
      const item = node("div", "metric");
      item.append(
        node("span", "metric-label", label),
        node("strong", "", count),
      );
      return item;
    }),
  );
  if (!runs.length) {
    runsNode.replaceChildren(
      node(
        "div",
        "empty",
        "Chưa có run nào. Dùng dispatch_tasks trong OpenCode; tác vụ sẽ xuất hiện ở đây.",
      ),
    );
    return;
  }
  runsNode.replaceChildren(
    ...runs.map((run) => {
      const section = node("section", "run");
      section.setAttribute("aria-label", `Run ${run.run_id}`);
      const heading = node("div", "run-head");
      const name = node(
        "div",
        "run-name",
        `RUN ${run.run_id.slice(0, 8).toUpperCase()}`,
      );
      name.append(node("span", "run-id", run.run_id));
      heading.append(
        name,
        node("span", "run-time", date(run.tasks[0]?.started_at)),
      );
      const columns = node("div", "columns");
      ["Tác vụ", "CLI / Model", "Trạng thái", "Thời gian", "Test", ""].forEach(
        (label) => columns.append(node("span", "", label)),
      );
      section.append(heading, columns);
      for (const task of run.tasks) {
        const details = node("details", "task");
        details.dataset.key = `${run.run_id}/${task.task_id}`;
        details.open = expanded.has(details.dataset.key);
        const summary = node("summary", "task-summary");
        const worker = node("div", "");
        worker.append(
          node(
            "span",
            "worker",
            task.worker === "agy" ? "Antigravity CLI" : "OpenCode CLI",
          ),
          node("span", "model", task.model || "Model mặc định"),
        );
        const testState = task.tests.length
          ? task.tests.every((test) => test.status === "passed")
            ? "passed"
            : "failed"
          : "";
        summary.append(
          node("span", "task-name", task.task_id),
          worker,
          node(
            "span",
            `status status-${task.status}`,
            labels[task.status] || task.status,
          ),
          node("span", "elapsed", duration(task)),
          node(
            "span",
            `test-state ${testState}`,
            testState === "passed"
              ? `${task.tests.length} qua`
              : testState === "failed"
                ? "Có lỗi"
                : "Chưa chạy",
          ),
          node("span", "chevron", "›"),
        );
        const content = node("div", "task-detail");
        content.append(
          block("Tóm tắt", task.summary, true),
          block("Worktree", task.worktree_path, true, true),
          block("Branch", task.branch, false, true),
          block("Log", task.log_path, false, true),
          block("Diff stat", task.diff_path, false, true),
          block("Mã thoát", task.exit_code === null ? "—" : task.exit_code),
          block("File đã đổi", task.changed_files?.join(", "), true, true),
          block(
            "Test",
            task.tests
              ?.map(
                (test) =>
                  `${test.command.join(" ")} → ${test.status} (${test.exit_code ?? "n/a"})`,
              )
              .join(" · "),
            true,
            true,
          ),
        );
        if (task.errors?.length)
          content.append(block("Lỗi", task.errors.join(" · "), true));
        details.append(summary, content);
        section.append(details);
      }
      return section;
    }),
  );
}

async function refresh() {
  button.disabled = true;
  try {
    const response = await fetch("/api/runs", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    render(data.runs);
    messageNode.replaceChildren();
    updatedNode.textContent = `Cập nhật lúc ${new Date().toLocaleTimeString("vi-VN")}`;
  } catch {
    messageNode.replaceChildren(
      node(
        "div",
        "alert",
        "Không đọc được báo cáo run. Kiểm tra dashboard server rồi thử làm mới.",
      ),
    );
  } finally {
    button.disabled = false;
  }
}
button.addEventListener("click", refresh);
refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 4000);
