import type { RelayVendor, RelayVendorId } from '../types.js';
import { photonVendor } from './photon.js';
import { sendblueVendor } from './sendblue.js';

export { photonVendor, sendblueVendor };
export {
  PHOTON_BASE_URL,
  PHOTON_SIGNATURE_HEADER,
  PHOTON_SIGNATURE_TOLERANCE_S,
  photonChatGuid,
  photonDmAddress,
  photonSignature,
} from './photon.js';
export { SENDBLUE_BASE_URL, SENDBLUE_SECRET_HEADER } from './sendblue.js';

export const RELAY_VENDORS: Readonly<Record<RelayVendorId, RelayVendor>> = {
  photon: photonVendor,
  sendblue: sendblueVendor,
};

export function relayVendor(id: RelayVendorId): RelayVendor {
  const v = RELAY_VENDORS[id];
  if (v === undefined) throw new Error(`unknown relay vendor ${String(id)}`);
  return v;
}
