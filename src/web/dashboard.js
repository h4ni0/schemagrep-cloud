(() => {
  "use strict";

  const element = (id) => {
    const value = document.getElementById(id);
    if (value === null) throw new Error(`Missing dashboard element: ${id}`);
    return value;
  };

  const accessPanel = element("access-panel");
  const accessForm = element("access-form");
  const accessSubmit = element("access-submit");
  const accessStatus = element("access-status");
  const apiKeyInput = element("api-key");
  const workspace = element("workspace");
  const forgetKey = element("forget-key");
  const uploadForm = element("upload-form");
  const uploadSubmit = element("upload-submit");
  const uploadStatus = element("upload-status");
  const fileInput = element("dataset-file");
  const fileLabel = element("file-label");
  const dropZone = document.querySelector(".drop-zone");
  const endpoint = element("mcp-endpoint");
  const copyConfig = element("copy-config");
  const configStatus = element("config-status");
  const datasetPanel = element("dataset-panel");
  const feedbackPanel = element("feedback-panel");
  const datasetName = element("dataset-name");
  const datasetSize = element("dataset-size");
  const datasetExpiry = element("dataset-expiry");
  const datasetCodec = element("dataset-codec");
  const datasetId = element("dataset-id");
  const questionTemplate = element("question-template");
  const copyId = element("copy-id");
  const copyQuestion = element("copy-question");
  const deleteDataset = element("delete-dataset");
  const datasetStatus = element("dataset-status");
  const feedbackForm = element("feedback-form");
  const feedbackClient = element("feedback-client");
  const feedbackOutcome = element("feedback-outcome");
  const feedbackQuestion = element("feedback-question");
  const feedbackExpected = element("feedback-expected");
  const feedbackNotes = element("feedback-notes");
  const feedbackConsent = element("feedback-consent");
  const feedbackSubmit = element("feedback-submit");
  const feedbackStatus = element("feedback-status");
  const usageStorage = element("usage-storage");
  const usageActiveFiles = element("usage-active-files");
  const usageSourceBytes = element("usage-source-bytes");
  const usageUploads = element("usage-uploads");
  const usageQueries = element("usage-queries");
  const usageMcp = element("usage-mcp");
  const usageProgress = element("usage-progress");
  const activeFiles = element("active-files");
  const usageStatus = element("usage-status");

  let apiKey = "";
  let oauthEnabled = false;
  let authGeneration = 0;
  let currentDataset = null;
  let expiryTimer = null;

  endpoint.textContent = `${window.location.origin}/mcp`;

  const setStatus = (target, message, kind = "") => {
    target.textContent = message;
    target.className = `status${kind ? ` ${kind}` : ""}`;
  };

  const errorMessage = async (response) => {
    try {
      const body = await response.json();
      if (body && body.error && typeof body.error.message === "string") return body.error.message;
    } catch {
      // The status text below is safer than rendering an unknown server body.
    }
    return `Request failed (${response.status})`;
  };

  const headers = () => ({ Authorization: `Bearer ${apiKey}` });

  const copyText = async (text, target, successMessage) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(target, successMessage, "success");
    } catch {
      setStatus(target, "Clipboard access was blocked. Copy the value manually.", "error");
    }
  };

  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  };

  const refreshUsage = async () => {
    const generation = authGeneration;
    const authorization = headers();
    try {
      const [usageResponse, filesResponse] = await Promise.all([
        fetch("/v1/usage", { headers: authorization }),
        fetch("/v1/files", { headers: authorization }),
      ]);
      if (generation !== authGeneration) return;
      if (!usageResponse.ok || !filesResponse.ok) {
        const failed = !usageResponse.ok ? usageResponse : filesResponse;
        const message = await errorMessage(failed);
        if (generation !== authGeneration) return;
        setStatus(usageStatus, message, "error");
        return;
      }
      const usage = await usageResponse.json();
      const listing = await filesResponse.json();
      if (generation !== authGeneration) return;
      const storage = usage.storage;
      const activity = usage.activity;
      usageActiveFiles.textContent = String(storage.activeFiles);
      usageSourceBytes.textContent = formatBytes(storage.sourceBytes);
      usageUploads.textContent = String(activity.successfulUploads);
      usageQueries.textContent = String(activity.queries);
      usageMcp.textContent = String(activity.mcpRequests);
      usageStorage.textContent = `${formatBytes(storage.retainedBytes)} / ${formatBytes(storage.maxRetainedBytes)}`;
      usageProgress.max = Math.max(1, storage.maxRetainedBytes);
      usageProgress.value = Math.max(0, storage.retainedBytes);
      activeFiles.replaceChildren();
      for (const file of listing.files) {
        const item = document.createElement("li");
        const identity = document.createElement("div");
        const name = document.createElement("strong");
        const id = document.createElement("code");
        const details = document.createElement("span");
        name.textContent = file.originalName;
        id.textContent = file.id;
        details.textContent = `${file.codec.toUpperCase()} · ${formatBytes(file.sourceBytes)} · expires ${new Date(file.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
        identity.append(name, id);
        item.append(identity, details);
        activeFiles.append(item);
      }
      if (listing.files.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = "No active datasets. Upload one to begin.";
        activeFiles.append(empty);
      }
      setStatus(usageStatus, activity.errors > 0 ? `${activity.errors} failed request${activity.errors === 1 ? "" : "s"} recorded.` : "Usage is scoped to this workspace.", activity.errors > 0 ? "error" : "success");
    } catch {
      if (generation === authGeneration) {
        setStatus(usageStatus, "Usage could not be loaded.", "error");
      }
    }
  };

  const updateExpiry = () => {
    if (currentDataset === null) return;
    const remainingMs = Date.parse(currentDataset.expiresAt) - Date.now();
    if (remainingMs <= 0) {
      datasetExpiry.textContent = "Expired";
      setStatus(datasetStatus, "This dataset has expired. Upload it again to continue.", "error");
      return;
    }
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    datasetExpiry.textContent = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  };

  const showDataset = (record) => {
    currentDataset = record;
    datasetName.textContent = record.originalName;
    datasetSize.textContent = formatBytes(record.sourceBytes);
    datasetCodec.textContent = record.codec;
    datasetId.textContent = record.id;
    const question = `Using schemagrep dataset ${record.id}, answer this question: `;
    questionTemplate.textContent = `${question}[your question]`;
    setStatus(datasetStatus, "Raw upload deleted. The query artifact is ready.", "success");
    datasetPanel.hidden = false;
    feedbackPanel.hidden = false;
    updateExpiry();
    if (expiryTimer !== null) window.clearInterval(expiryTimer);
    expiryTimer = window.setInterval(updateExpiry, 30_000);
    datasetPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const resetDataset = (hideFeedback = false) => {
    currentDataset = null;
    datasetPanel.hidden = true;
    if (hideFeedback) feedbackPanel.hidden = true;
    setStatus(datasetStatus, "");
    if (expiryTimer !== null) window.clearInterval(expiryTimer);
    expiryTimer = null;
  };

  accessForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const generation = ++authGeneration;
    const candidate = apiKeyInput.value.trim();
    if (candidate.length === 0) return;
    accessSubmit.disabled = true;
    setStatus(accessStatus, "Checking invite…");
    try {
      const response = await fetch("/v1/session", {
        headers: { Authorization: `Bearer ${candidate}` },
      });
      if (generation !== authGeneration) return;
      if (!response.ok) {
        const message = await errorMessage(response);
        if (generation !== authGeneration) return;
        setStatus(accessStatus, message, "error");
        return;
      }
      const session = await response.json();
      if (generation !== authGeneration) return;
      oauthEnabled = session.oauth === true;
      apiKey = candidate;
      apiKeyInput.value = "";
      accessPanel.hidden = true;
      workspace.hidden = false;
      setStatus(accessStatus, "");
      setStatus(configStatus, "Connected for this tab only.", "success");
      await refreshUsage();
      fileInput.focus();
    } catch {
      if (generation === authGeneration) {
        setStatus(accessStatus, "Could not reach schemagrep. Try again.", "error");
      }
    } finally {
      if (generation === authGeneration) accessSubmit.disabled = false;
    }
  });

  forgetKey.addEventListener("click", () => {
    authGeneration += 1;
    apiKey = "";
    oauthEnabled = false;
    resetDataset(true);
    uploadForm.reset();
    fileLabel.textContent = "Choose a file";
    workspace.hidden = true;
    accessPanel.hidden = false;
    setStatus(uploadStatus, "");
    setStatus(configStatus, "");
    feedbackForm.reset();
    setStatus(feedbackStatus, "");
    activeFiles.replaceChildren();
    usageProgress.value = 0;
    apiKeyInput.focus();
  });

  fileInput.addEventListener("change", () => {
    fileLabel.textContent = fileInput.files && fileInput.files[0]
      ? fileInput.files[0].name
      : "Choose a file";
    setStatus(uploadStatus, "");
  });

  for (const eventName of ["dragenter", "dragover"]) {
    dropZone.addEventListener(eventName, () => dropZone.classList.add("dragging"));
  }
  for (const eventName of ["dragleave", "drop"]) {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove("dragging"));
  }

  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      setStatus(uploadStatus, "Choose a supported file first.", "error");
      return;
    }
    uploadSubmit.disabled = true;
    setStatus(uploadStatus, "Uploading and creating the schema…");
    const body = new FormData();
    body.append("file", file);
    try {
      const response = await fetch("/v1/files", {
        method: "POST",
        headers: headers(),
        body,
      });
      if (!response.ok) {
        setStatus(uploadStatus, await errorMessage(response), "error");
        return;
      }
      const record = await response.json();
      setStatus(uploadStatus, "Dataset ready.", "success");
      showDataset(record);
      void refreshUsage();
    } catch {
      setStatus(uploadStatus, "Upload failed before the server responded. Try again.", "error");
    } finally {
      uploadSubmit.disabled = false;
    }
  });

  copyConfig.addEventListener("click", () => {
    const config = {
      mcpServers: {
        schemagrep: {
          type: "http",
          url: `${window.location.origin}/mcp`,
          ...(oauthEnabled ? {} : { headers: { Authorization: `Bearer ${apiKey}` } }),
        },
      },
    };
    void copyText(JSON.stringify(config, null, 2), configStatus, "MCP configuration copied.");
  });

  copyId.addEventListener("click", () => {
    if (currentDataset !== null) void copyText(currentDataset.id, datasetStatus, "Dataset ID copied.");
  });

  copyQuestion.addEventListener("click", () => {
    if (currentDataset === null) return;
    const question = `Using schemagrep dataset ${currentDataset.id}, answer this question: `;
    void copyText(question, datasetStatus, "Starter question copied.");
  });

  feedbackForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!feedbackConsent.checked) {
      setStatus(feedbackStatus, "Consent is required before storing question text.", "error");
      return;
    }
    feedbackSubmit.disabled = true;
    setStatus(feedbackStatus, "Sending feedback…");
    const expectedAnswer = feedbackExpected.value.trim();
    const notes = feedbackNotes.value.trim();
    const payload = {
      client: feedbackClient.value.trim(),
      outcome: feedbackOutcome.value,
      question: feedbackQuestion.value.trim(),
      ...(expectedAnswer.length === 0 ? {} : { expectedAnswer }),
      ...(notes.length === 0 ? {} : { notes }),
      consentToStoreText: true,
    };
    try {
      const response = await fetch("/v1/feedback", {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        setStatus(feedbackStatus, await errorMessage(response), "error");
        return;
      }
      feedbackForm.reset();
      setStatus(feedbackStatus, "Thank you. Your feedback was saved without file data.", "success");
    } catch {
      setStatus(feedbackStatus, "Feedback could not reach the server. Try again.", "error");
    } finally {
      feedbackSubmit.disabled = false;
    }
  });

  deleteDataset.addEventListener("click", async () => {
    if (currentDataset === null) return;
    deleteDataset.disabled = true;
    setStatus(datasetStatus, "Deleting dataset…");
    try {
      const response = await fetch(`/v1/files/${encodeURIComponent(currentDataset.id)}`, {
        method: "DELETE",
        headers: headers(),
      });
      if (!response.ok && response.status !== 404) {
        setStatus(datasetStatus, await errorMessage(response), "error");
        return;
      }
      resetDataset();
      uploadForm.reset();
      fileLabel.textContent = "Choose a file";
      setStatus(uploadStatus, "Dataset deleted. You can upload another file.", "success");
      await refreshUsage();
    } catch {
      setStatus(datasetStatus, "Could not delete the dataset. Try again.", "error");
    } finally {
      deleteDataset.disabled = false;
    }
  });
})();
