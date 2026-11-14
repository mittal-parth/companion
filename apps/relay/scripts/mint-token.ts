/**
 * Prints a signed relay token, for trying the relay by hand before accounts
 * hand out VMs (Task 4.4). `vm` is what a daemon presents to connect, `web` is
 * what a caller presents to reach that VM.
 *
 *   RELAY_SECRET=... node scripts/mint-token.ts <vm|web> <vm-id> [minutes]
 */
import { signToken } from "@companion/shared/tunnel";

const [role, vm, minutes = "60"] = process.argv.slice(2);
const secret = (process.env.RELAY_SECRET ?? "").trim();
if ((role !== "vm" && role !== "web") || vm === undefined || secret === "") {
  console.error(
    "Usage: RELAY_SECRET=... mint-token.ts <vm|web> <vm-id> [minutes]",
  );
  process.exit(1);
}
const exp = Math.floor(Date.now() / 1000) + Number(minutes) * 60;
console.log(signToken({ role, vm, exp }, secret));
