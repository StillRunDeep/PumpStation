import { generateDefaultTopology, runTopology } from './src/agents/topology.js'

console.log('Testing topology generation...')
const topology = generateDefaultTopology(2, 0)
console.log('拓扑节点:', topology.nodes.map(n => ({ id: n.id, label: n.label })))
console.log('拓扑设备:', topology.devices.map(d => ({ id: d.id, label: d.label, nodeIds: d.nodeIds })))
console.log('拓扑管道:', topology.pipes.map(p => ({ node1: p.node1, node2: p.node2 })))

const result = runTopology(topology)
console.log('验证结果:', { valid: result.valid, errors: result.errors, warnings: result.warnings })
console.log('可达节点:', result.dischargeReachable)
console.log('孤立设备:', result.isolated.map(d => d.label))