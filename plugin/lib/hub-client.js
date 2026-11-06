// Talking to the hub with this device's token.

export class HubError extends Error {
  constructor(message, { status = null, data = null, network = false } = {}) {
    super(message);
    this.status = status;
    this.data = data;
    this.network = network;
  }
}

export async function hubRequest(config, method, route, body, { timeout = 10_000 } = {}) {
  let response;
  try {
    response = await fetch(`${config.hub}${route}`, {
      method,
      headers: {
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new HubError(`Can't reach the hub at ${config.hub}: ${error.message}`, { network: true });
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // Handled by the status check below.
  }
  if (!response.ok) {
    throw new HubError(data?.message ?? `Hub returned ${response.status}`, { status: response.status, data });
  }
  return data;
}

// Follows a server-sent event stream until it ends or `signal` aborts.
export async function followStream(config, route, { signal, onEvent }) {
  const response = await fetch(`${config.hub}${route}`, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok) {
    let message = `Hub returned ${response.status}`;
    try {
      message = (await response.json()).message ?? message;
    } catch {
      // Keep the status message.
    }
    throw new HubError(message, { status: response.status });
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      if (dataLines.length) await onEvent(event, JSON.parse(dataLines.join('\n')));
    }
  }
}
