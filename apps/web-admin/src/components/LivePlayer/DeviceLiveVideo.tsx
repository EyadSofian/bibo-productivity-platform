import { LivePlayer } from "./LivePlayer";
import { livekitTransport } from "../../media/livekitTransport";

export default function DeviceLiveVideo({ deviceId }: { deviceId: string }) {
  return <LivePlayer deviceId={deviceId} transport={livekitTransport} />;
}
