// The TURN health-check timer uses Node-only APIs (dgram/tls), so it lives in
// a separate module loaded only via dynamic import — a static top-level
// import here would get bundled into the Edge instrumentation graph too and
// fail to compile, even though `register()` never calls it there.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
