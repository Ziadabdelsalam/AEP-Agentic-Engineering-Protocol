// Reads a pairing link pasted into the app. A home screen app has no address bar, so pasting is the
// only way a link can reach it. The secret in the link stays on this device, as with an opened link.
export function parsePairingLink(text, origin) {
  const match = String(text ?? '').trim().match(/^(?:(https?:\/\/[^/#\s]+)\/?)?#?pair\/([\w-]+)\/([\w-]+)$/);
  if (!match) return { error: "That doesn't look like a pairing link. Run aep pair-browser to get one." };
  if (match[1] && match[1] !== origin) return { error: `That link is for ${match[1]}, not this hub.` };
  return { id: match[2], secret: match[3] };
}
