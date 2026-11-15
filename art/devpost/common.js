// Shared by every Devpost picture: the two paper filters from app/index.html, and alphabet stickers.
// <span data-letters="Jester"></span> becomes one sticker per letter, colours and tilts in a fixed order,
// so a render is the same every time.

const DEFS = `
<svg class="defs" aria-hidden="true">
  <filter id="die-cut" x="-8%" y="-20%" width="120%" height="150%" color-interpolation-filters="sRGB">
    <feMorphology in="SourceAlpha" operator="dilate" radius="8" result="grown" />
    <feOffset in="grown" dx="5" dy="6" result="dropped" />
    <feFlood flood-color="#1E1B18" flood-opacity="0.34" /><feComposite in2="dropped" operator="in" result="shadow" />
    <feFlood flood-color="#ffffff" /><feComposite in2="grown" operator="in" result="rim" />
    <feMerge><feMergeNode in="shadow" /><feMergeNode in="rim" /><feMergeNode in="SourceGraphic" /></feMerge>
  </filter>
  <filter id="sticker" x="-12%" y="-12%" width="130%" height="130%" color-interpolation-filters="sRGB">
    <feMorphology in="SourceAlpha" operator="dilate" radius="5" result="grown" />
    <feOffset in="grown" dx="4" dy="5" result="dropped" />
    <feFlood flood-color="#1E1B18" flood-opacity="0.34" /><feComposite in2="dropped" operator="in" result="shadow" />
    <feFlood flood-color="#ffffff" /><feComposite in2="grown" operator="in" result="rim" />
    <feMerge><feMergeNode in="shadow" /><feMergeNode in="rim" /><feMergeNode in="SourceGraphic" /></feMerge>
  </filter>
</svg>`;
document.body.insertAdjacentHTML("afterbegin", DEFS);

const COLORS = ["#D93A2B", "#4F7BF0", "#F47FA6", "#FFC93C", "#3FBF8F"];
const TILTS = [-4, 3, -2, 4, -3, 2, -1, 3];
const LIFTS = [4, -4, 2, -3, 3, -2, 1, -3];

// Pages that read their words from the address (the track banner) fill [data-param] elements first.
const params = new URLSearchParams(location.search);
for (const el of document.querySelectorAll("[data-param]")) {
  const value = params.get(el.dataset.param);
  if (value === null) continue;
  if (el.hasAttribute("data-letters")) el.dataset.letters = value;
  else el.textContent = value;
}

for (const el of document.querySelectorAll("[data-letters]")) {
  const word = el.dataset.letters;
  const offset = Number(el.dataset.offset || 0);
  el.classList.add("letters");
  el.setAttribute("aria-label", word);
  let i = 0;
  el.innerHTML = [...word].map((ch) => {
    if (ch === " ") return '<span style="width:.32em"></span>';
    const k = i++ + offset;
    return `<span style="--c:${COLORS[k % COLORS.length]};--r:${TILTS[k % TILTS.length]}deg;--y:${LIFTS[k % LIFTS.length]}px">${ch}</span>`;
  }).join("");
}
