/**
 * Ditto Router sessions — an OpenCode plugin loaded by BitBull when a Router key is set.
 *
 * The Router files requests into threads by X-Ditto-Session-Id; without it, every chat's requests
 * within ten minutes of each other share one thread. Provider headers in OpenCode's config are
 * fixed for the whole server, so the id is added per request here: the OpenCode session, which is
 * one BitBull chat (or one subagent run inside it). See server/src/router.ts.
 */
export const DittoRouterSessions = async () => ({
  "chat.headers": async (input, output) => {
    if (String(input.model?.providerID ?? "").startsWith("ditto-router")) output.headers["X-Ditto-Session-Id"] = input.sessionID;
  },
});
