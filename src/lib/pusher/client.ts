/**
 * Browser-side Pusher singleton. pusher-js is imported lazily so pages that
 * fall back to polling never download it, and it never runs during SSR.
 */
import type PusherClient from "pusher-js";

export type PublicRealtimeConfig = { key: string; cluster: string };

let instance: PusherClient | null = null;
let instanceKey = "";
/** In-flight creation, shared by concurrent callers (e.g. StrictMode double effects). */
let pending: Promise<PusherClient> | null = null;
let pendingKey = "";

type PusherCtor = new (key: string, options: ConstructorParameters<typeof PusherClient>[1]) => PusherClient;

/** Overridable for tests; defaults to the lazy pusher-js import. */
let loadPusher: () => Promise<PusherCtor> = () => import("pusher-js").then((m) => m.default as PusherCtor);

export function __setPusherLoaderForTests(loader: (() => Promise<PusherCtor>) | null): void {
  loadPusher = loader ?? (() => import("pusher-js").then((m) => m.default as PusherCtor));
  instance?.disconnect();
  instance = null;
  instanceKey = "";
  pending = null;
  pendingKey = "";
}

export function getPusherClient(config: PublicRealtimeConfig): Promise<PusherClient> {
  const key = `${config.key}:${config.cluster}`;
  if (instance && instanceKey === key) return Promise.resolve(instance);
  if (pending && pendingKey === key) return pending;

  instance?.disconnect();
  instance = null;
  instanceKey = "";
  pendingKey = key;
  const p: Promise<PusherClient> = loadPusher()
    .then((Pusher) => {
      if (pendingKey !== key) throw new Error("superseded");
      const created = new Pusher(config.key, {
        cluster: config.cluster,
        forceTLS: true,
        channelAuthorization: { endpoint: "/api/pusher/auth", transport: "ajax" },
      });
      instance = created;
      instanceKey = key;
      return created;
    })
    .finally(() => {
      if (pending === p) pending = null;
    });
  pending = p;
  return p;
}
