import type { Module, NicheTemplate } from './types';
import { MODES } from './modes';
import academia from './academia';
import barberia from './barberia';
import consultorio from './consultorio';
import fotografia from './fotografia';
import gimnasio from './gimnasio';
import hospedaje from './hospedaje';
import inmobiliaria from './inmobiliaria';
import legal_contable from './legal_contable';
import makeup from './makeup';
import odontologia from './odontologia';
import peluqueria from './peluqueria';
import peluqueria_canina from './peluqueria_canina';
import psicologia from './psicologia';
import restaurante from './restaurante';
import spa from './spa';
import taller from './taller';
import tienda from './tienda';
import unas from './unas';
import veterinaria from './veterinaria';

export const NICHES: NicheTemplate[] = [academia, barberia, consultorio, fotografia, gimnasio, hospedaje, inmobiliaria, legal_contable, makeup, odontologia, peluqueria, peluqueria_canina, psicologia, restaurante, spa, taller, tienda, unas, veterinaria];

const byId = new Map(NICHES.map((n) => [n.id, n]));

export function getNiche(id: string) {
  return byId.get(id) ?? null;
}

export function modulesFor(niche: NicheTemplate): Module[] {
  return [...new Set([...MODES[niche.mode].modules, ...(niche.extraModules ?? [])])];
}

/** Lo que el panel necesita para pintar las tarjetas del onboarding. */
export function publicCatalog() {
  return NICHES.map((n) => ({
    id: n.id, label: n.label, description: n.description, icon: n.icon, mode: n.mode, modeLabel: MODES[n.mode].label,
  }));
}

export { MODES };
export type { NicheTemplate };
