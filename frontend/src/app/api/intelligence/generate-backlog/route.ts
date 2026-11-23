// Owner-only cesta pro stávající AI funkci (/api/ai/generate-backlog drží zavřenou firewall); stejný handler i gateway, oprávnění hlídá authenticate().
export { POST } from '../../ai/generate-backlog/route';
