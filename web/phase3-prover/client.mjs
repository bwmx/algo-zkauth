const button = document.getElementById("run");
const cancel = document.getElementById("cancel");
const status = document.getElementById("status");
let worker;
let timer;
let current;
let message;

function finish() {
  clearInterval(timer);
  worker?.terminate();
  worker = undefined;
  button.disabled = false;
  cancel.disabled = true;
}
function render() {
  status.textContent =
    message +
    (worker
      ? `\nElapsed: ${Math.floor((performance.now() - current.started) / 1000)} seconds.`
      : "");
}
function saveFailure(errorCode) {
  void fetch("/prover/failure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...current, errorCode }),
  }).catch(() => {});
}
button.addEventListener("click", () => {
  current = {
    source: document.getElementById("source").value,
    userAgent: navigator.userAgent,
    mode: "single-thread",
    stage: "worker-start",
    started: performance.now(),
  };
  button.disabled = true;
  cancel.disabled = false;
  message = "Starting the browser worker…";
  try {
    worker = new Worker("/prover/worker.js");
    worker.onmessage = ({ data }) => {
      current.stage = data.stage;
      current.runId = data.runId;
      message = data.message;
      if (data.done) finish();
      render();
    };
    worker.onerror = (event) => {
      event.preventDefault();
      const errorCode = /allocat|memory/i.test(event.message ?? "")
        ? "memory-allocation"
        : "worker-startup";
      message = `Browser worker failed at ${current.stage} (${errorCode}). Failure telemetry was saved when available; retry or inspect the local benchmark record.`;
      saveFailure(errorCode);
      finish();
      render();
    };
    worker.onmessageerror = () => {
      message = `Browser worker communication failed at ${current.stage}. Failure telemetry was saved when available; retry or inspect the local benchmark record.`;
      saveFailure("prover-error");
      finish();
      render();
    };
    worker.postMessage(current);
    timer = setInterval(render, 1000);
    render();
  } catch {
    message =
      "The browser could not start a worker. Failure telemetry was saved when available; retry or inspect the local benchmark record.";
    saveFailure("worker-startup");
    finish();
    render();
  }
});
cancel.addEventListener("click", () => {
  saveFailure("user-cancelled");
  message = `Browser proof cancelled at ${current.stage}.`;
  finish();
  render();
});
