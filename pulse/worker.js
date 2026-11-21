// Pulse: kort adresse som viser det samme som batblikk.seriksso.workers.dev.
export default {
  async fetch(request, env) {
    return env.APP.fetch(request);
  },
};
