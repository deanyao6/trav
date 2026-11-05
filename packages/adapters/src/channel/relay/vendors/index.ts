import type { RelayVendor, RelayVendorId } from '../types.js';
import { bluebubblesVendor } from './bluebubbles.js';
import { photonVendor } from './photon.js';
import { sendblueVendor } from './sendblue.js';

export { bluebubblesVendor, photonVendor, sendblueVendor };
export {
  PHOTON_BASE_URL,
  PHOTON_SIGNATURE_HEADER,
  PHOTON_SIGNATURE_TOLERANCE_S,
  photonChatGuid,
  photonDmAddress,
  photonSignature,
} from './photon.js';
export { SENDBLUE_BASE_URL, SENDBLUE_SECRET_HEADER } from './sendblue.js';
export type { BlueBubblesVendorOptions } from './bluebubbles.js';
export {
  BLUEBUBBLES_GROUP_STYLE,
  BLUEBUBBLES_MAX_SENDS_PER_DAY,
  BLUEBUBBLES_MOCK_SERVER_URL,
  BLUEBUBBLES_TOKEN_PARAM,
  blueBubblesAttachmentUrl,
  blueBubblesChatGuid,
  blueBubblesDmAddress,
  blueBubblesServerOrigin,
  createBlueBubblesVendor,
} from './bluebubbles.js';

/**
 * The default module per vendor. For BlueBubbles that is the module against
 * the fake server (`BLUEBUBBLES_MOCK_SERVER_URL`); a live line builds its own
 * with `createBlueBubblesVendor` from `TRAV_BLUEBUBBLES_URL` (config.ts).
 */
export const RELAY_VENDORS: Readonly<Record<RelayVendorId, RelayVendor>> = {
  photon: photonVendor,
  sendblue: sendblueVendor,
  bluebubbles: bluebubblesVendor,
};

export function relayVendor(id: RelayVendorId): RelayVendor {
  const v = RELAY_VENDORS[id];
  if (v === undefined) throw new Error(`unknown relay vendor ${String(id)}`);
  return v;
}
