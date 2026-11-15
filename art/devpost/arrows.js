// Ballpoint arrows between diagram cards, drawn after layout so they follow the cards wherever they land.
// Each link: [from card number, to card number, side the arrow leaves from, label?, dashed?].
// Sides: "right", "left", "down", "up". Numbers are the cards' data-n.

function drawArrows(links) {
  const wrap = document.querySelector(".cards");
  const box = wrap.getBoundingClientRect();
  const card = (n) => {
    const r = document.querySelector(`.card[data-n="${n}"]`).getBoundingClientRect();
    return { l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top, cx: (r.left + r.right) / 2 - box.left, cy: (r.top + r.bottom) / 2 - box.top };
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "arrows");
  svg.setAttribute("width", box.width);
  svg.setAttribute("height", box.height);
  let html = "";
  for (const [from, to, side, label, dashed] of links) {
    const a = card(from), b = card(to);
    let x1, y1, x2, y2, bend;
    if (side === "right") { x1 = a.r + 6; y1 = a.cy - 20; x2 = b.l - 8; y2 = b.cy - 10; bend = [0, -14]; }
    if (side === "left") { x1 = a.l - 6; y1 = a.cy + 10; x2 = b.r + 8; y2 = b.cy + 20; bend = [0, 14]; }
    if (side === "down") { x1 = a.cx + 40; y1 = a.b + 12; x2 = b.cx + 40; y2 = b.t - 16; bend = [36, 0]; }
    if (side === "up") { x1 = a.cx - 60; y1 = a.t - 12; x2 = b.cx - 60; y2 = b.b + 16; bend = [-36, 0]; }
    const mx = (x1 + x2) / 2 + bend[0], my = (y1 + y2) / 2 + bend[1];
    // Arrowhead along the curve's last direction.
    const dx = x2 - mx, dy = y2 - my, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const head = (turn) => {
      const c = Math.cos(turn), s = Math.sin(turn);
      return `${x2 - 26 * (ux * c - uy * s)} ${y2 - 26 * (ux * s + uy * c)}`;
    };
    html += `<path class="pen" ${dashed ? 'stroke-dasharray="2 12"' : ""} d="M${x1} ${y1} Q${mx} ${my} ${x2} ${y2}"/>`;
    html += `<path class="pen" d="M${head(0.5)} L${x2} ${y2} L${head(-0.5)}"/>`;
    if (label) {
      const lx = side === "up" || side === "down" ? mx + (side === "up" ? -18 : 18) : mx;
      const ly = side === "up" || side === "down" ? my + 10 : my + (side === "left" ? 44 : -16);
      const anchor = side === "up" ? "end" : side === "down" ? "start" : "middle";
      html += `<text x="${lx}" y="${ly}" text-anchor="${anchor}" style="font: 700 30px var(--hand); letter-spacing: -.04em; fill: var(--pen)">${label}</text>`;
    }
  }
  svg.innerHTML = html;
  wrap.appendChild(svg);
}
