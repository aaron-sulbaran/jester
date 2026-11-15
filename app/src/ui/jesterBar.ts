// Every loading bar in the game: a dashed paper track, a striped fill whose stripes march forward, and the
// jester running along the top at the fill's edge (art/jester/jester.py --run). The real <progress> stays in
// place, visually hidden, so screen readers still hear the value; the bar only mirrors it.

/** Upgrades every <progress> under `root`. Safe to call again: a bar is only upgraded once. */
export function jesterBars(root: ParentNode = document) {
  for (const bar of root.querySelectorAll<HTMLProgressElement>("progress")) upgrade(bar);
}

function upgrade(bar: HTMLProgressElement) {
  if (bar.dataset.jesterBar) return;
  bar.dataset.jesterBar = "1";
  const wrap = document.createElement("div");
  wrap.className = "jbar";
  bar.before(wrap);
  wrap.append(bar);
  bar.classList.add("jbar-native");
  wrap.insertAdjacentHTML("beforeend", `<span class="jbar-track" aria-hidden="true"><span class="jbar-fill"></span></span><span class="jbar-runner" aria-hidden="true"></span>`);
  const sync = () => {
    // Setting progress.value writes the value attribute, so watching the attribute catches every update.
    const share = bar.max > 0 ? Math.min(1, Math.max(0, bar.value / bar.max)) : 0;
    wrap.style.setProperty("--p", share.toFixed(4));
    wrap.classList.toggle("done", share >= 1);
    wrap.hidden = bar.hidden;
  };
  new MutationObserver(sync).observe(bar, { attributes: true, attributeFilter: ["value", "max", "hidden"] });
  sync();
}
