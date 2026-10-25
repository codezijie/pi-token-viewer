/* Apply the saved theme before first paint to avoid a flash. */
(function () {
  var stored = "auto";
  try {
    stored = localStorage.getItem("pi-token-viewer-theme") || "auto";
  } catch (_) {
    stored = "auto";
  }
  if (stored !== "light" && stored !== "dark" && stored !== "auto") stored = "auto";
  document.documentElement.setAttribute("data-theme", stored);
})();
