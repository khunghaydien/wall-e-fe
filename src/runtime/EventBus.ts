type EventHandler<T> = (payload: T) => void;

export class EventBus<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<
    keyof Events,
    Set<EventHandler<Events[keyof Events]>>
  >();

  on<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): () => void {
    const existing = this.listeners.get(event) ?? new Set();
    existing.add(handler as EventHandler<Events[keyof Events]>);
    this.listeners.set(event, existing);

    return () => {
      existing.delete(handler as EventHandler<Events[keyof Events]>);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      handler(payload);
    }
  }
}
