/**
 * src/modules/billing/vat.ts
 *
 * EU VAT for advertising sold by a seller in Germany to businesses:
 *
 * - A customer in Germany pays German VAT, 19%.
 * - A customer in another EU country with a VAT ID that the EU's VIES service confirms
 *   pays no VAT on the invoice: the reverse charge. The customer accounts for it in
 *   their own country.
 * - A customer in another EU country without a confirmed VAT ID is charged German VAT.
 * - A customer outside the EU pays no German VAT: the service is supplied where the
 *   business customer is.
 */
import type { Organisation } from '@prisma/client';
import { env } from '@/config/env';

export const SELLER_COUNTRY = 'DE';
export const GERMAN_VAT_BP = 1900;

export const EU_COUNTRIES = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
] as const;

/**
 * Countries a customer can be in: the EU, and the others the dashboard offers. A fixed
 * list, because any other code would count as "outside the EU" and pay no VAT.
 */
export const BILLING_COUNTRIES = [...EU_COUNTRIES, 'NO', 'CH', 'GB', 'US'] as const;

/** VAT IDs start with the country code, except Greece, which uses EL. */
export const vatPrefix = (country: string): string => (country === 'GR' ? 'EL' : country);

export interface VatTreatment {
  rateBp: number;
  note: string;
}

type Party = Pick<Organisation, 'country' | 'vatId' | 'vatIdVerifiedAt'>;

export const vatFor = (organisation: Party): VatTreatment => {
  const { country } = organisation;
  if (!country || country === SELLER_COUNTRY) return { rateBp: GERMAN_VAT_BP, note: '' };
  if ((EU_COUNTRIES as readonly string[]).includes(country)) {
    if (organisation.vatId && organisation.vatIdVerifiedAt) {
      return {
        rateBp: 0,
        note: 'Reverse charge: the recipient accounts for the VAT (Article 196, Council Directive 2006/112/EC).',
      };
    }
    return {
      rateBp: GERMAN_VAT_BP,
      note: organisation.vatId
        ? 'German VAT charged: the EU VAT ID could not be confirmed.'
        : 'German VAT charged: no EU VAT ID was given.',
    };
  }
  return {
    rateBp: 0,
    note: 'Not subject to German VAT: advertising services for a business outside the EU (§ 3a (2) UStG).',
  };
};

/** VAT on a net amount, to the cent. */
export const vatOn = (netCents: number, rateBp: number): number =>
  Math.round((netCents * rateBp) / 10_000);

/** A net amount with its VAT, rounded up, for what a campaign must hold. */
export const grossUp = (netCents: number, rateBp: number): number =>
  netCents + Math.ceil((netCents * rateBp) / 10_000);

export type VatCheck = 'valid' | 'invalid' | 'unavailable';

/**
 * Asks the EU's VIES service whether a VAT ID is registered. Free and public. When
 * VIES or the country's own system is down, the answer is "unavailable", not "invalid".
 */
export const checkVatId = async (country: string, vatId: string): Promise<VatCheck> => {
  const prefix = vatPrefix(country);
  const number = vatId.startsWith(prefix) ? vatId.slice(prefix.length) : vatId;
  try {
    const response = await fetch(`${env.VIES_URL}/ms/${prefix}/vat/${encodeURIComponent(number)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return 'unavailable';
    const body = (await response.json()) as { isValid?: boolean; userError?: string };
    if (body.isValid === true) return 'valid';
    if (body.userError && body.userError !== 'VALID' && body.userError !== 'INVALID') {
      return 'unavailable';
    }
    return 'invalid';
  } catch {
    return 'unavailable';
  }
};
