(() => {
  const root = document.documentElement;
  const themeButton = document.querySelector(".theme-toggle");
  const themeLabel = themeButton.querySelector(".theme-state");
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const systemLight = matchMedia("(prefers-color-scheme: light)");
  const themeKey = "portfolio-theme";
  let preference;

  function setTheme(value) {
    preference = value === "light" || value === "dark" ? value : null;
    const light = (preference || (systemLight.matches ? "light" : "dark")) === "light";
    root.dataset.theme = light ? "light" : "dark";
    themeColor.content = light ? "#edeee6" : "#10110f";
    themeButton.setAttribute("aria-pressed", String(light));
    themeButton.title = light ? "Switch to dark theme" : "Switch to light theme";
    themeLabel.textContent = light ? "Light" : "Dark";
  }

  try { preference = localStorage.getItem(themeKey); } catch {}
  setTheme(preference);
  themeButton.hidden = false;

  themeButton.addEventListener("click", () => {
    setTheme(root.dataset.theme === "light" ? "dark" : "light");
    try { localStorage.setItem(themeKey, preference); } catch {}
  });

  systemLight.addEventListener("change", () => {
    if (!preference) setTheme(null);
  });

  window.addEventListener("storage", (event) => {
    if (event.key === themeKey || event.key === null) setTheme(event.newValue);
  });

  const article = document.querySelector(".post-content");
  if (!article) return;

  const status = document.createElement("div");
  status.className = "screen-reader-only";
  status.setAttribute("role", "status");
  article.before(status);

  const scrollObserver = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      if (target.scrollWidth > target.clientWidth + 1) target.tabIndex = 0;
      else target.removeAttribute("tabindex");
    }
  });

  const languageNames = {
    bash: "Shell",
    cpp: "C++",
    cs: "C#",
    cuda: "CUDA",
    js: "JavaScript",
    json: "JSON",
    py: "Python",
    plaintext: "Text",
    python: "Python",
    sh: "Shell",
    shell: "Shell",
    sql: "SQL",
    text: "Text",
    ts: "TypeScript",
    yaml: "YAML"
  };

  const terminalIcon = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 5.5 4.5 4.5-4.5 4.5M11 14.5h4.5"/></svg>';
  const copyIcon = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="1"/><path d="M5 13H4V4h9v1"/></svg>';
  const scrollIcon = '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 10h12.75m-4-4 4 4-4 4"/></svg>';

  for (const pre of article.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (!code || pre.closest(".rouge-table")) continue;

    const block = pre.closest(".highlighter-rouge, figure.highlight") || pre;
    const classes = [...block.classList, ...code.classList];
    const language = classes.find((name) => name.startsWith("language-"))?.slice(9) || "text";
    const label = Object.hasOwn(languageNames, language) ? languageNames[language] : language;

    const panel = document.createElement("div");
    panel.className = "code-panel";
    const bar = document.createElement("div");
    bar.className = "code-bar";
    bar.innerHTML = `<span class="code-language">${terminalIcon}<span></span></span>
      <span class="scroll-hint" aria-hidden="true">Scroll ${scrollIcon}</span>
      <button type="button" class="copy-code">${copyIcon}<span>Copy</span></button>`;
    bar.querySelector(".code-language span").textContent = label;
    const button = bar.querySelector("button");
    const buttonText = button.querySelector("span");
    let reset;

    button.addEventListener("click", async () => {
      clearTimeout(reset);
      button.removeAttribute("data-copied");
      status.textContent = "";
      try {
        await navigator.clipboard.writeText(code.textContent);
        button.dataset.copied = "true";
        buttonText.textContent = "Copied";
        status.textContent = "Code copied to the clipboard.";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        buttonText.textContent = "Selected";
        status.textContent = "Code selected. Use your device’s copy shortcut.";
      }

      reset = setTimeout(() => {
        button.removeAttribute("data-copied");
        buttonText.textContent = "Copy";
        status.textContent = "";
      }, 1800);
    });

    block.before(panel);
    panel.append(bar, block);
    pre.setAttribute("aria-label", `${label} code block`);
    scrollObserver.observe(pre);
  }

  for (const table of article.querySelectorAll("table")) {
    if (table.closest(".highlight, .js-plotly-plot")) continue;
    const viewport = document.createElement("div");
    viewport.className = "table-scroll";
    viewport.setAttribute("role", "region");
    viewport.setAttribute("aria-label", table.caption?.textContent.trim() || "Article table");
    viewport.innerHTML = `<span class="scroll-hint" aria-hidden="true">Scroll table ${scrollIcon}</span>`;
    table.before(viewport);
    viewport.append(table);
    scrollObserver.observe(viewport);
  }

  for (const chart of article.querySelectorAll(".plotly-graph-div")) {
    chart.setAttribute("role", "region");
    chart.setAttribute("aria-label", "Interactive chart");
    scrollObserver.observe(chart);
  }
})();
