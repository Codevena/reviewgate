const fallbackCopy = (text) => {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy command failed");
};

const copyText = async (button, text) => {
  const original = button.textContent;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else fallbackCopy(text);
    button.textContent = "Copied ✓";
  } catch {
    try {
      fallbackCopy(text);
      button.textContent = "Copied ✓";
    } catch {
      button.textContent = "Copy failed";
    }
  }
  window.setTimeout(() => { button.textContent = original; }, 1800);
};

document.querySelectorAll("[data-copy]").forEach((command) => {
  const button = command.querySelector("button");
  button?.addEventListener("click", () => copyText(button, command.dataset.copy ?? ""));
});

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = document.querySelector(button.dataset.copyTarget ?? "");
    if (target) copyText(button, target.innerText);
  });
});

const header = document.querySelector("[data-header]");
const menuButton = document.querySelector(".menu-toggle");

const closeMenu = () => {
  header?.classList.remove("menu-open");
  menuButton?.setAttribute("aria-expanded", "false");
};

menuButton?.addEventListener("click", () => {
  const open = header?.classList.toggle("menu-open") ?? false;
  menuButton.setAttribute("aria-expanded", String(open));
});

header?.querySelectorAll(".mobile-nav a").forEach((link) => link.addEventListener("click", closeMenu));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});

const updateHeader = () => header?.classList.toggle("scrolled", window.scrollY > 20);
window.addEventListener("scroll", updateHeader, { passive: true });
updateHeader();

const setupContent = {
  1: {
    title: "Terminal / 01 install",
    note: "The npm package selects the matching native binary for your operating system and CPU architecture.",
    html: `<span class="code-comment"># Install the prebuilt binary for this machine</span>\n<span class="code-prompt">$</span> npm i -g reviewgate\n\n<span class="code-ok">✓ reviewgate installed</span>`,
  },
  2: {
    title: "Terminal / 02 initialize",
    note: "One command owns the complete first run: policy, hosts, native hooks, initial last-known-good fingerprint and health check.",
    html: `<span class="code-comment"># Enter the repository and start the guided flow</span>\n<span class="code-prompt">$</span> cd your-repo\n<span class="code-prompt">$</span> reviewgate init\n\n<span class="code-ok">? Protect: Claude Code + Codex</span>`,
  },
  3: {
    title: "Terminal / 03 configure",
    note: "Custom mode covers reviewers, models, fallbacks, critic, memory, sandbox, soft-pass policy, notifications and pre-push behaviour.",
    html: `<span class="code-ok">? Setup mode: Custom</span>\n<span class="code-ok">? Reviewers: Codex, Gemini, Claude…</span>\n<span class="code-ok">? Reviewer subprocess sandbox: Strict</span>\n<span class="code-ok">✓ hooks installed · LKG recorded</span>`,
  },
  4: {
    title: "Terminal / 04 activate & verify",
    note: "Codex activation is deliberately user-controlled. Trust the exact hash once, and repeat only when the generated definitions change.",
    html: `<span class="code-comment"># Inside Codex — Reviewgate cannot self-approve</span>\n<span class="code-prompt">/</span>hooks\n<span class="code-ok">Review: SessionStart · PostToolUse · Stop</span>\n<span class="code-ok">Trust the exact project-hook hash</span>\n\n<span class="code-prompt">$</span> reviewgate doctor`,
  },
};

const setupTabs = [...document.querySelectorAll(".setup-step")];
const setupCode = document.querySelector("#setup-code code");
const setupTitle = document.querySelector("#setup-title");
const setupNote = document.querySelector("#setup-note");

const selectSetupStep = (selected, moveFocus = false) => {
  setupTabs.forEach((tab) => {
    const active = tab === selected;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  const content = setupContent[selected.dataset.step];
  if (content && setupCode && setupTitle && setupNote) {
    setupCode.style.opacity = "0";
    window.setTimeout(() => {
      setupTitle.textContent = content.title;
      setupCode.innerHTML = content.html;
      setupNote.textContent = content.note;
      setupCode.style.opacity = "1";
    }, 100);
  }
  if (moveFocus) selected.focus();
};

setupTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectSetupStep(tab));
  tab.addEventListener("keydown", (event) => {
    let nextIndex = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % setupTabs.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + setupTabs.length) % setupTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = setupTabs.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      selectSetupStep(setupTabs[nextIndex], true);
    }
  });
});

document.querySelectorAll(".faq details").forEach((detail) => {
  detail.addEventListener("toggle", () => {
    if (!detail.open) return;
    document.querySelectorAll(".faq details[open]").forEach((other) => {
      if (other !== detail) other.open = false;
    });
  });
});

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: .1 });
  document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
} else {
  document.querySelectorAll(".reveal").forEach((element) => element.classList.add("visible"));
}

const readout = document.querySelector("#cursor-readout");
if (readout && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  window.addEventListener("pointermove", (event) => {
    const x = String(Math.round(event.clientX)).padStart(4, "0");
    const y = String(Math.round(event.clientY)).padStart(4, "0");
    readout.textContent = `POINTER ${x}:${y} / SIGNAL LOCKED`;
  }, { passive: true });
}
