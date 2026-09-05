/** Display formatting. Indian numbering, because the payroll is in rupees. */
import { TENANT_TIMEZONE } from '../../../shared/tenant.ts';

export function formatMoney(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(value);
}

/**
 * Headline figures drop the paise. On a two-crore total the decimals are noise,
 * and they push the number past the width a KPI tile can hold.
 */
export function formatMoneyWhole(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency, maximumFractionDigits: 0,
  }).format(value);
}

/** Compact form for chart axes and dense tiles: 12.4L, 1.2Cr. */
export function formatMoneyShort(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined) return '—';

  // The symbol is looked up rather than written in. Its siblings above already
  // take a currency, so hardcoding one here put rupee signs on the axes of a
  // chart drawn from a structure denominated in something else.
  const symbol = new Intl.NumberFormat('en-IN', { style: 'currency', currency })
    .formatToParts(0)
    .find((part) => part.type === 'currency')?.value ?? '';

  const absolute = Math.abs(value);
  if (absolute >= 10_000_000) return `${symbol}${(value / 10_000_000).toFixed(2)}Cr`;
  if (absolute >= 100_000) return `${symbol}${(value / 100_000).toFixed(1)}L`;
  if (absolute >= 1_000) return `${symbol}${(value / 1_000).toFixed(1)}k`;
  return `${symbol}${value.toFixed(0)}`;
}

/**
 * A date for display.
 *
 * A bare 'YYYY-MM-DD' is a calendar fact with no timezone, so it is read in UTC
 * to stop the local zone shifting it a day. A full timestamp is an instant, and
 * is read in the tenant zone -- the same zone formatDateTime uses. Reading both
 * in UTC meant the two helpers disagreed about the day for the same value:
 * 22:30Z showed as the 5th here and the 6th in formatDateTime.
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const isBareDate = value.length === 10;

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    timeZone: isBareDate ? 'UTC' : TENANT_TIMEZONE,
  }).format(new Date(isBareDate ? `${value}T00:00:00Z` : value));
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: TENANT_TIMEZONE, hour12: false,
  }).format(new Date(value));
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit', minute: '2-digit', timeZone: TENANT_TIMEZONE, hour12: false,
  }).format(new Date(value));
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: digits, minimumFractionDigits: digits,
  }).format(value);
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Maps a workflow or record state to one of the badge colour variants. */
export function stateVariant(state: string): string {
  switch (state) {
    case 'paid':
    case 'approved':
    case 'validated':
    case 'running':
    case 'active':
    case 'present':
      return 'success';
    case 'to_approve':
    case 'computed':
    case 'late':
    case 'missing_checkout':
    case 'on_leave':
      return 'warning';
    case 'refused':
    case 'cancelled':
    case 'absent':
    case 'terminated':
      return 'danger';
    case 'overtime':
      return 'info';
    default:
      return '';
  }
}

export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  return value.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase());
}
