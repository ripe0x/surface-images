/**
 * Arweave uploads through ArDrive Turbo, paid in ETH. An Ethereum key signs
 * each upload (an ANS-104 data item with a normal Arweave ID) and spends the
 * Turbo credits it bought with `topUp`. Signing is local and deterministic, so
 * an upload is saved before it is sent, and re-sending the same signed item is
 * a duplicate Turbo does not charge for.
 */
import { createHash } from "node:crypto"
import { Readable } from "node:stream"
import { createData, EthereumSigner } from "@dha-team/arbundles"
import { ETHToTokenAmount, TurboFactory } from "@ardrive/turbo-sdk"
import { privateKeyToAccount } from "viem/accounts"

export const ARWEAVE_GATEWAY = "https://arweave.net"
export const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex")

export interface SignedUpload { id: string; sha256: string; item: Buffer }

/** Offline: no network, no spend. The same key, bytes and tags always give the same ID. */
export async function signUpload(privateKey: string, data: Buffer, tags: { name: string; value: string }[]): Promise<SignedUpload> {
  const signer = new EthereumSigner(privateKey.replace(/^0x/, ""))
  const item = createData(data, signer, { tags })
  await item.sign(signer)
  if (!(await item.isValid())) throw new Error("signed upload failed validation")
  return { id: item.id, sha256: sha256Hex(data), item: Buffer.from(item.getRaw()) }
}

/** True once arweave.net serves exactly these bytes; false while it is not there yet. */
export async function servedMatches(id: string, sha256: string, fetchFn: typeof fetch = fetch, gateway = ARWEAVE_GATEWAY): Promise<boolean> {
  const response = await fetchFn(`${gateway}/${id}`, { signal: AbortSignal.timeout(60_000) })
  if (response.status === 404 || response.status === 202) return false
  if (!response.ok) throw new Error(`Arweave gateway returned ${response.status}`)
  if (sha256Hex(Buffer.from(await response.arrayBuffer())) !== sha256) throw new Error(`Arweave bytes for ${id} do not match the signed PNG`)
  return true
}

export function createTurbo(privateKey: string, ethRpcUrl: string) {
  const address = privateKeyToAccount(privateKey as `0x${string}`).address
  const turbo = TurboFactory.authenticated({ privateKey, token: "ethereum", gatewayUrl: ethRpcUrl })
  return {
    address,
    /** Credits (winc) this key holds. */
    balance: async () => BigInt((await turbo.getBalance()).winc),
    /** Credits one upload of `bytes` costs. */
    cost: async (bytes: number) => BigInt((await turbo.getUploadCosts({ bytes: [bytes] }))[0].winc),
    /** Credits `eth` would buy at today's rate. */
    quoteEth: async (eth: number) => BigInt((await turbo.getWincForToken({ tokenAmount: ETHToTokenAmount(eth) })).winc),
    /** Sends `eth` from this key on Ethereum mainnet to Turbo and credits this key. */
    topUp: (eth: number) => turbo.topUpWithTokens({ tokenAmount: ETHToTokenAmount(eth) }),
    async upload(signed: SignedUpload) {
      const result = await turbo.uploadSignedDataItem({
        dataItemStreamFactory: () => Readable.from(signed.item),
        dataItemSizeFactory: () => signed.item.length,
      })
      if (result.id !== signed.id) throw new Error(`Turbo stored ${result.id}, expected ${signed.id}`)
      return { winc: result.winc }
    },
  }
}
