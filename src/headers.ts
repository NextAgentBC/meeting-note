// Headers every response from a copy carries, whichever way it was served: public/_headers says the
// same for the template's static files, and the installer's copies embed their files in the Worker,
// so they get these from secureResponse(). test/headers.test.ts keeps the two lists equal.
//
// No page of the app may be framed — the sign-in and recovery screens least of all — and nothing it
// links to learns which page (or which private calendar address) someone came from. The policy
// restricts only framing, <base>, plugins and form targets, so it cannot break a script or a style.
// Referrer-Policy is same-origin, not no-referrer: no-referrer would send "Origin: null" on some
// same-site requests, and sameOriginWrites refuses those.
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  // Recording needs the microphone and, for Zoom, the screen; nothing needs a location or payments.
  "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()"
};

export function secureResponse(response: Response): Response {
  // A protocol switch cannot be copied into a new Response.
  if (response.status === 101) return response;
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!secured.headers.has(name)) secured.headers.set(name, value);
  }
  return secured;
}
