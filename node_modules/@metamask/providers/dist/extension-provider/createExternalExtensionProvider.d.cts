import { StreamProvider } from "../StreamProvider.cjs";
export type ExtensionType = 'stable' | 'flask' | 'beta' | string;
/**
 * Creates an external extension provider for the given extension type or ID.
 * This is intended for use by 3rd party extensions.
 *
 * @param typeOrId - The extension type or ID.
 * @returns The external extension provider.
 */
export declare function createExternalExtensionProvider(typeOrId?: ExtensionType): StreamProvider;
//# sourceMappingURL=createExternalExtensionProvider.d.cts.map