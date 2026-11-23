// Owner-only cesta pro stávající AI funkci (/api/ai/daily-brief drží zavřenou firewall); stejný handler i gateway, oprávnění hlídá authenticate().
export { POST } from '../../ai/daily-brief/route';
