import { QueryClient } from "@tanstack/react-query";
import { createConfig, http } from "wagmi";
import { bscTestnet, mainnet } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

const connectors = [injected({ shimDisconnect: true })];
const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;

if (walletConnectProjectId) {
  connectors.push(
    walletConnect({
      projectId: walletConnectProjectId,
      showQrModal: true
    })
  );
}

export const queryClient = new QueryClient();

export const wagmiConfig = createConfig({
  chains: [bscTestnet, mainnet],
  connectors,
  transports: {
    [bscTestnet.id]: http(),
    [mainnet.id]: http()
  }
});
