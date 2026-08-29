import { CustomerModuleMarketplace, type CustomerModuleMarketVersion } from './customerModuleMarketplace.js';
import type { CustomerModuleMarketplaceStore } from './customerModuleRepository.js';
import {
  handleCustomerModuleMarketplaceRequest,
  type CustomerModuleRouteRequest,
  type CustomerModuleRouteResponse,
} from './customerModuleRoutes.js';
import { submitCustomerModulePackage } from './customerModuleSubmission.js';

export function createCustomerModuleMarketplaceFacade(store: CustomerModuleMarketplaceStore) {
  const market = new CustomerModuleMarketplace(undefined, store);

  return {
    get(moduleId: string, version: string): CustomerModuleMarketVersion | null {
      return market.get(moduleId, version);
    },
    getArtifacts(moduleId: string, version: string): Map<string, Uint8Array> {
      return store.getArtifacts(moduleId, version);
    },
    submit(input: {
      publisherId: string;
      manifest: unknown;
      files: ReadonlyMap<string, Uint8Array>;
    }): Promise<CustomerModuleMarketVersion> {
      return submitCustomerModulePackage({ ...input, market, store });
    },
    handle(
      request: CustomerModuleRouteRequest,
      options: {
        signApprovedVersion?: (
          moduleId: string,
          version: string,
        ) => { keyId: string; value: string };
      } = {},
    ): CustomerModuleRouteResponse {
      return handleCustomerModuleMarketplaceRequest(market, request, options);
    },
  };
}

export type CustomerModuleMarketplaceFacade = ReturnType<
  typeof createCustomerModuleMarketplaceFacade
>;
