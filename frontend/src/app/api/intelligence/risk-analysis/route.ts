// Owner-only cesta pro stávající AI funkci (/api/ai/risk-analysis drží zavřenou firewall); stejný handler i gateway, oprávnění hlídá authenticate().
export { POST } from '../../ai/risk-analysis/route';
