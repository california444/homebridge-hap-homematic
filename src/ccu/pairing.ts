/**
 * HmIP transmitter / virtual-receiver pairing (plan 8.4).
 *
 * HmIP actuators (HmIP-PS, -DRSI4, -BROLL, -FROLL, …) expose one
 * `<KIND>_TRANSMITTER` channel with the real output state, followed by
 * three `<KIND>_VIRTUAL_RECEIVER` channels that take commands. A receiver
 * only reports its own (virtual) state, not the output (3.1, finding 4).
 * So: read state from the transmitter, send commands to the first
 * receiver after it. The grouping follows the channel order (CHILDREN),
 * not fixed numbers.
 *
 *   HmIP-PS        2 SWITCH_TRANSMITTER   → 3 SWITCH_VIRTUAL_RECEIVER
 *   HmIP-DRSI4     5/9/13/17 SWITCH_TRANSMITTER → 6/10/14/18
 *   HmIP-BROLL     3 SHUTTER_TRANSMITTER  → 4 SHUTTER_VIRTUAL_RECEIVER
 */

import type { CcuChannel, CcuDevice } from '../types.js';

const PAIR_RE = /^(SWITCH|SHUTTER|BLIND|DIMMER)_(TRANSMITTER|VIRTUAL_RECEIVER)$/;

/**
 * For a mapped transmitter or receiver channel return a channel whose
 * `address` is the command channel (first receiver of the group) and
 * whose `stateAddress` is the transmitter. Anything else is returned
 * unchanged.
 */
export function pairChannel(device: CcuDevice | undefined, channel: CcuChannel): CcuChannel {
  const m = PAIR_RE.exec(channel.type);
  if (!device || !m) {
    return channel;
  }
  const kind = m[1]!;
  const transmitterType = `${kind}_TRANSMITTER`;
  const receiverType = `${kind}_VIRTUAL_RECEIVER`;
  const channels = [...device.channels].sort((a, b) => a.index - b.index);
  const pos = channels.findIndex((c) => c.address === channel.address);
  if (pos === -1) {
    return channel;
  }

  // The group's transmitter: the channel itself or the nearest one before it.
  let tx = -1;
  for (let i = pos; i >= 0; i--) {
    if (channels[i]!.type === transmitterType) {
      tx = i;
      break;
    }
  }
  if (tx === -1) {
    return channel;
  }
  const receiver = channels[tx + 1];
  if (!receiver || receiver.type !== receiverType) {
    return channel;
  }
  return { ...channel, address: receiver.address, stateAddress: channels[tx]!.address };
}
