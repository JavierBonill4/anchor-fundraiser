import * as anchor from "@coral-xyz/anchor";

/** `u64` / `i64` seed bytes, little-endian, as the program writes them. */
const le8 = (value: anchor.BN | number | bigint): Buffer =>
  new anchor.BN(value.toString()).toArrayLike(Buffer, "le", 8);

/**
 * `[b"fundraiser", maker, id]`
 *
 * The id is what lets one maker run more than one campaign: without it every
 * campaign for a given maker lands on the same address, and the second one can
 * never be created.
 */
export const fundraiserPda = (
  programId: anchor.web3.PublicKey,
  maker: anchor.web3.PublicKey,
  id: anchor.BN | number
): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("fundraiser"), maker.toBuffer(), le8(id)],
    programId
  )[0];

/**
 * `[b"contributor", fundraiser, contributor, time_started]`
 *
 * `time_started` is in here, and not just the fundraiser address, because a
 * maker may reuse an id once the campaign that held it has been closed. Without
 * it, a Contributor account stranded by a *successful* campaign would collide
 * with the same person's account in the reused one — and `init_if_needed` would
 * hand back the old balance rather than a fresh account.
 *
 * The cost is that this address cannot be derived until the campaign exists:
 * the caller has to read `time_started` off the Fundraiser first.
 */
export const contributorPda = (
  programId: anchor.web3.PublicKey,
  fundraiser: anchor.web3.PublicKey,
  contributor: anchor.web3.PublicKey,
  timeStarted: anchor.BN | number | bigint
): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("contributor"), fundraiser.toBuffer(), contributor.toBuffer(), le8(timeStarted)],
    programId
  )[0];
