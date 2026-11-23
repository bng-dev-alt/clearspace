// Owner-only cesta pro stávající AI funkci (/api/ai/capacity-planning drží zavřenou firewall); stejný handler i gateway, oprávnění hlídá authenticate().
export { POST } from '../../ai/capacity-planning/route';
