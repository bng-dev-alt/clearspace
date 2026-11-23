// Owner-only cesta pro stávající AI funkci (/api/ai/generate-project drží zavřenou firewall); stejný handler i gateway, oprávnění hlídá authenticate().
export { POST } from '../../ai/generate-project/route';
