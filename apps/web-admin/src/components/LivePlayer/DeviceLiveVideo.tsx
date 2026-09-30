import { LivePlayer } from "./LivePlayer";
import { livekitTransport } from "../../media/livekitTransport";

export default function DeviceLiveVideo({ deviceId, online = true }: { deviceId: string; online?: boolean }) {
  return <LivePlayer deviceId={deviceId} transport={livekitTransport} online={online} />;
}
