import { LivePlayer } from "./LivePlayer";
import { livekitTransport } from "../../media/livekitTransport";

/** The live player wired to the real SFU. `autoStart` is for places where the
 *  viewer already asked to watch (a "Watch live" button), so they are not
 *  asked a second time. */
export default function DeviceLiveVideo({
  deviceId,
  online = true,
  autoStart = false,
}: {
  deviceId: string;
  online?: boolean;
  autoStart?: boolean;
}) {
  return <LivePlayer deviceId={deviceId} transport={livekitTransport} online={online} autoStart={autoStart && online} />;
}
