import type { BusinessKind } from "./api/types";
import i18n from "./i18n";

/** Workforce vocabulary used throughout the management experience.
 *
 * The backend still accepts the historical `family` kind so existing databases
 * remain readable, but this product is now an employee-monitoring platform. A
 * legacy workspace must therefore render the same employee terminology as a
 * new team workspace instead of exposing the legacy personal-workspace copy. */
export interface MemberTerms {
  one: string;
  many: string;
  lowerOne: string;
  lowerMany: string;
  addCta: string;
  idAbbrev: string;
  org: string;
}

/** Resolve localized employee terminology. `kind` is intentionally accepted
 *  for API compatibility but no longer changes the product vocabulary. */
export function memberTerms(_kind: BusinessKind | undefined | null): MemberTerms {
  const term = (k: string) => i18n.t(`terms.team.${k}`, { ns: "common" });
  return {
    one: term("one"),
    many: term("many"),
    lowerOne: term("lowerOne"),
    lowerMany: term("lowerMany"),
    addCta: term("addCta"),
    idAbbrev: "emp",
    org: term("org"),
  };
}
