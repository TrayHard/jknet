import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { failureOf } from "./api";

/**
 * The sentence a failed read or write of a community screen prints.
 *
 * The contract's codes have sentences of their own in the `community`
 * catalog, because the general ones speak of accounts and devices: a
 * `404` here is a community that is gone, a `409 limit` the 200
 * subscriptions of an account. Anything else prints the message it came
 * with, which the service writes in English.
 */
export function useFailureText(): (error: unknown) => string {
  const { t } = useTranslation("community");
  return useCallback(
    (error: unknown) => {
      const failure = failureOf(error);
      switch (failure.code) {
        case "not_found":
        case "notFound":
          return t("errors.notFound");
        case "unauthorized":
        case "signedOut":
          return t("errors.unauthorized");
        case "forbidden":
          return t("errors.forbidden");
        case "limit":
          return t("errors.limit", { message: failure.message });
        case "rate_limited":
        case "rateLimited":
          return t("errors.rateLimited");
        case "network":
          return t("errors.network");
        case "conflict":
          return t("errors.conflict", { message: failure.message });
        case "invalid":
        case "invalidInput":
          return t("errors.invalid", { message: failure.message });
        case "provider_error":
          return t("errors.providerError");
        case "internal":
          return t("errors.internal");
        default:
          return failure.message !== "" ? failure.message : t("errors.unknown");
      }
    },
    [t],
  );
}
