/**
 * Saved signatures / initials (PNG data URLs) and custom text stamps, persisted in the store.
 */
import { create } from "zustand";
import { api } from "../lib/ipc";
import { createLogger } from "../lib/log";
import { decodeImageUrl } from "../annotations/images";
import type { StampImage } from "../annotations/model";

const log = createLogger("signatures");

export interface SavedSignature {
  id: string;
  kind: "signature" | "initials";
  url: string;
  width: number;
  height: number;
  createdAt: number;
}

export interface CustomStamp {
  id: string;
  label: string;
  color: string;
}

interface SignatureState {
  signatures: SavedSignature[];
  stamps: CustomStamp[];
  loaded: boolean;
  load: () => Promise<void>;
  addSignature: (sig: Omit<SavedSignature, "id" | "createdAt">) => SavedSignature;
  removeSignature: (id: string) => void;
  addStamp: (stamp: Omit<CustomStamp, "id">) => CustomStamp;
  removeStamp: (id: string) => void;
  clearSignatures: () => void;
}

function persist(get: () => SignatureState) {
  const { signatures, stamps } = get();
  api.storeWrite("signatures", { signatures, stamps }).catch((err) => log.error("failed to save signatures", err));
}

export const useSignatures = create<SignatureState>((set, get) => ({
  signatures: [],
  stamps: [],
  loaded: false,
  load: async () => {
    try {
      const read = await api.storeRead<{ signatures?: SavedSignature[]; stamps?: CustomStamp[] }>("signatures");
      const v = read.value ?? {};
      set({
        signatures: Array.isArray(v.signatures) ? v.signatures.filter((s) => typeof s?.url === "string") : [],
        stamps: Array.isArray(v.stamps) ? v.stamps.filter((s) => typeof s?.label === "string") : [],
        loaded: true,
      });
    } catch (err) {
      log.warn("failed to load signatures", err);
      set({ loaded: true });
    }
  },
  addSignature: (sig) => {
    const entry: SavedSignature = { ...sig, id: crypto.randomUUID(), createdAt: Date.now() };
    set({ signatures: [...get().signatures, entry].slice(-12) });
    persist(get);
    return entry;
  },
  removeSignature: (id) => {
    set({ signatures: get().signatures.filter((s) => s.id !== id) });
    persist(get);
  },
  addStamp: (stamp) => {
    const entry: CustomStamp = { ...stamp, id: crypto.randomUUID() };
    set({ stamps: [...get().stamps, entry].slice(-40) });
    persist(get);
    return entry;
  },
  removeStamp: (id) => {
    set({ stamps: get().stamps.filter((s) => s.id !== id) });
    persist(get);
  },
  clearSignatures: () => {
    set({ signatures: [] });
    persist(get);
  },
}));

const decoded = new Map<string, Promise<StampImage>>();

/** Decode (and cache) a saved signature into a stamp image. */
export function signatureImage(sig: SavedSignature): Promise<StampImage> {
  let p = decoded.get(sig.id);
  if (!p) {
    p = decodeImageUrl(sig.url);
    decoded.set(sig.id, p);
    p.catch(() => decoded.delete(sig.id));
  }
  return p;
}
