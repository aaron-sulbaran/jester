// Anything that comes from another player (a name, a role label, a score) must be escaped before it goes into
// innerHTML, or a name like <img src=x onerror=...> would run in every browser in the room.

/** Escapes text for use inside HTML (element text and double or single quoted attributes). */
export const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A CSS colour from a safe set (#hex only), else a neutral grey, for putting into a style attribute. */
export const safeColor = (value: unknown): string => (/^#[0-9a-fA-F]{3,8}$/.test(String(value)) ? String(value) : "#888");
