const main = document.querySelector("main") || document.body.appendChild(document.createElement("main"));
const card = document.createElement("section");
document.documentElement.dataset.pad = "browser";
card.dataset.padBrowser = "";
card.textContent = "Browser mode: pad.mjs is running. Use Chrome file permissions for self-save, or run this PAD for trusted local capabilities.";
main.append(card);
