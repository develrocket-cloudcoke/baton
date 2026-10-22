import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Tailwind 클래스 네임 합성 유틸리티
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
