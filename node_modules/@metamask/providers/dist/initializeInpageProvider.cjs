"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeProvider = initializeProvider;
exports.setGlobalProvider = setGlobalProvider;
exports.announceCaip294WalletData = announceCaip294WalletData;
const CAIP294_1 = require("./CAIP294.cjs");
const EIP6963_1 = require("./EIP6963.cjs");
const MetaMaskInpageProvider_1 = require("./MetaMaskInpageProvider.cjs");
const shimWeb3_1 = require("./shimWeb3.cjs");
/**
 * Initializes a MetaMaskInpageProvider and (optionally) assigns it as window.ethereum.
 *
 * @param options - An options bag.
 * @param options.connectionStream - A Node.js stream.
 * @param options.maxEventListeners - The maximum number of event listeners.
 * @param options.providerInfo - The EIP-6963 provider info / CAIP-294 wallet data that should be announced if set.
 * @param options.shouldSendMetadata - Whether the provider should send page metadata.
 * @param options.shouldSetOnWindow - Whether the provider should be set as window.ethereum.
 * @param options.shouldShimWeb3 - Whether a window.web3 shim should be injected.
 * @param options.logger - The logging API to use. Default: `console`.
 * @param options.shouldAnnounceCaip294 - Whether the provider should announce itself.
 * @returns The initialized provider (whether set or not).
 */
function initializeProvider({ connectionStream, logger = console, maxEventListeners = 100, providerInfo, shouldSendMetadata = true, shouldSetOnWindow = true, shouldShimWeb3 = false, shouldAnnounceCaip294 = true, }) {
    const provider = new MetaMaskInpageProvider_1.MetaMaskInpageProvider(connectionStream, {
        logger,
        maxEventListeners,
        shouldSendMetadata,
    });
    const proxiedProvider = new Proxy(provider, {
        // some common libraries, e.g. web3@1.x, mess with our API
        deleteProperty: () => true,
        // fix issue with Proxy unable to access private variables from getters
        // https://stackoverflow.com/a/73051482
        get(target, propName) {
            return target[propName];
        },
    });
    if (providerInfo) {
        (0, EIP6963_1.announceProvider)({
            info: providerInfo,
            provider: proxiedProvider,
        });
        if (shouldAnnounceCaip294) {
            // eslint-disable-next-line no-void
            void announceCaip294WalletData(provider, providerInfo);
        }
    }
    if (shouldSetOnWindow) {
        setGlobalProvider(proxiedProvider);
    }
    if (shouldShimWeb3) {
        (0, shimWeb3_1.shimWeb3)(proxiedProvider, logger);
    }
    return proxiedProvider;
}
/**
 * Sets the given provider instance as window.ethereum and dispatches the
 * 'ethereum#initialized' event on window.
 *
 * @param providerInstance - The provider instance.
 */
function setGlobalProvider(providerInstance) {
    try {
        window.ethereum = providerInstance;
        window.dispatchEvent(new Event('ethereum#initialized'));
    }
    catch (error) {
        console.error('MetaMask encountered an error setting the global Ethereum provider - this is likely due to another Ethereum wallet extension also setting the global Ethereum provider:', error);
    }
}
/**
 * Announces [CAIP-294](https://github.com/ChainAgnostic/CAIPs/blob/bc4942857a8e04593ed92f7dc66653577a1c4435/CAIPs/caip-294.md) wallet data according to build type and browser.
 * Until released to stable, `extensionId` is only set in the `metamask_getProviderState` result if the build type is `flask`.
 * `extensionId` is included if browser is chromium based because it is only useable by browsers that support [externally_connectable](https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable).
 *
 * @param provider - The provider {@link MetaMaskInpageProvider} used for retrieving `extensionId`.
 * @param providerInfo - The provider info {@link BaseProviderInfo} that should be announced if set.
 */
async function announceCaip294WalletData(provider, providerInfo) {
    const providerState = await provider.request({
        method: 'metamask_getProviderState',
    });
    const targets = [];
    const extensionId = providerState?.extensionId;
    if (extensionId) {
        targets.push({
            type: 'caip-348',
            value: extensionId,
        });
    }
    const walletData = {
        ...providerInfo,
        targets,
    };
    (0, CAIP294_1.announceWallet)(walletData);
}
//# sourceMappingURL=initializeInpageProvider.cjs.map