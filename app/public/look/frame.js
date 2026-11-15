// The viewing harness for the look mockups: shows each direction's three screens at laptop (1440) and
// phone (390) width. The screens themselves live in <id>-screens.html?s=start|play|reveal.
const DIRECTIONS = [
  { id: "a", name: "Parlor Cards", line: "A card game at the kitchen table. The Jester deals each of you a secret part, face down." },
  { id: "b", name: "Cut Paper", line: "Scrappy and handmade. Your body becomes a paper cutout glued into the clip." },
  { id: "c", name: "Hot Seat", line: "Everything cut away but you, your outline and one number. The whole screen turns your colour on your turn." },
  { id: "d", name: "Glue Stick", line: "A scrapbook of your game night, made as it happens: photos, tape, stickers and notes in the margins." },
  { id: "e", name: "Sketch Pad", line: "Everything drawn by hand in a sketchbook. Each player owns a highlighter, and the Jester doodles in the margins." },
  { id: "f", name: "Royal Court", line: "A castle's great hall. You are the jester performing for the throne, and the winner takes the seat." },
  { id: "g", name: "Velvet Stage", line: "Red curtains, footlights and a drum roll. The spotlight finds the best performance." },
  { id: "h", name: "Toy Theater", line: "A paper toy theatre on the table. Your cutouts slide on stage like puppets on sticks." },
];
const SCREENS = [
  { s: "start", title: "Start", note: "Pick a starter clip, upload one or record one. Seated switch." },
  { s: "play", title: "Blind play", note: "Aaron's turn. He got the dog, sees only its outline, never the clip." },
  { s: "reveal", title: "Reveal and results", note: "The clip with each player standing where their part was, the scores, then play again or send it." },
];

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

function device(kind, src) {
  const [w, h] = kind === "laptop" ? [1440, 900] : [390, 844];
  const frame = el("iframe", { src, width: String(w), height: String(h), loading: "lazy", title: kind });
  const box = el("div", { class: `device ${kind}` }, frame);
  box.dataset.w = String(w); box.dataset.h = String(h);
  return el("figure", {}, box, el("figcaption", {}, kind === "laptop" ? "Laptop, 1440 wide" : "Phone, 390 wide"));
}

function fit() {
  for (const box of document.querySelectorAll(".device")) {
    const w = Number(box.dataset.w), h = Number(box.dataset.h);
    const s = Math.min(1, box.parentElement.clientWidth / w);
    box.firstElementChild.style.transform = `scale(${s})`;
    box.style.width = `${w * s}px`;
    box.style.height = `${h * s}px`;
  }
}

function buildGallery(id) {
  const d = DIRECTIONS.find((x) => x.id === id);
  document.title = `Jester look: ${d.name}`;
  const nav = el("nav", {}, el("a", { href: "index.html" }, "All looks"), ...DIRECTIONS.map((x) => el("a", { href: `${x.id}.html`, ...(x.id === id ? { "aria-current": "page" } : {}) }, x.name)), el("a", { href: "research.html" }, "Research"));
  const head = el("header", {}, nav, el("h1", {}, d.name), el("p", {}, d.line),
    el("p", { class: "open" }, "Open the screens on their own: ", ...SCREENS.flatMap((sc, i) => [el("a", { href: `${id}-screens.html?s=${sc.s}`, target: "_blank" }, sc.title), i < SCREENS.length - 1 ? ", " : ""])));
  const main = el("main");
  for (const sc of SCREENS) {
    const src = `${id}-screens.html?s=${sc.s}`;
    main.append(el("section", {}, el("h2", {}, sc.title), el("p", { class: "note" }, sc.note),
      el("div", { class: "pair" }, device("laptop", src), device("phone", src))));
  }
  document.body.append(head, main);
  fit();
  addEventListener("resize", fit);
}

function buildIndex() {
  const main = el("main", { class: "index" });
  for (const d of DIRECTIONS) {
    const src = `${d.id}-screens.html?s=start`;
    const thumb = el("div", { class: "device laptop" }, el("iframe", { src, width: "1440", height: "900", title: d.name, tabindex: "-1" }));
    thumb.dataset.w = "1440"; thumb.dataset.h = "900";
    main.append(el("a", { class: "pick", href: `${d.id}.html` }, el("figure", {}, thumb), el("h2", {}, `${d.id.toUpperCase()}. ${d.name}`), el("p", {}, d.line)));
  }
  document.body.append(el("header", {}, el("h1", {}, "Jester: the looks"), el("p", {}, "Each one shows the same three screens at laptop and phone width. Pick one, or tell me which parts to mix."), el("p", {}, el("a", { href: "research.html" }, "What the research says"), ": the references behind them, and what to steal.")), main);
  fit();
  addEventListener("resize", fit);
}

const which = document.currentScript?.dataset.direction;
if (which) buildGallery(which); else buildIndex();
