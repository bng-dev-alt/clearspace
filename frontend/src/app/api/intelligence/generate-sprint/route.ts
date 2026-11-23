// Owner-only cesta pro stávající AI funkci (/api/ai/generate-sprint drží zavřenou firewall); stejný handler i gateway, oprávnění hlídá authenticate().
export { POST } from '../../ai/generate-sprint/route';
