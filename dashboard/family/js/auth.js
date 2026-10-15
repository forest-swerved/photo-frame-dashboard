let client;
export async function authClient() {
  if (!client) {
    const { createAuthClient } = await import('@neondatabase/auth');
    client = createAuthClient(`${window.location.origin}/api/auth`);
  }
  return client;
}

export async function userToken() {
  return tokenForClient(await authClient());
}

export async function tokenForClient(auth) {
  try {
    const session = await auth.getSession();
    if (session.error) {
      if ([401, 403].includes(session.error.status)) return null;
      throw session.error;
    }
    if (!session.data?.session) return null;
    // @neondatabase/auth 0.6.0-beta shares its session cache with /token.
    // Its supported force-fetch option bypasses that cache and strips this
    // header before fetching, so the result is a JWT response, not a session.
    const { data, error } = await auth.token({ fetchOptions: { headers: { 'X-Force-Fetch': 'true' } } });
    if (error) {
      if ([401, 403].includes(error.status)) return null;
      throw error;
    }
    return data?.token || null;
  } catch (error) {
    // This SDK version throws AuthApiError for /token on a signed-out session.
    // That is an ordinary sign-in state, not a dashboard connection failure.
    if ([401, 403].includes(error.status)) return null;
    throw error;
  }
}
