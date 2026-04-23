1. src/ui/layout-panel.js (视图层 View)负责 DOM 的生成和更新。
   * DOM 渲染
   * UI 状态维护
   * 暴露 UI 更新 API
   * 边界：它不管算法是怎么运行的，也不主动调用核心算法，仅仅接收数据并把它画出来。
1. src/ui/layout-controller.js (控制层 Controller)处理交互与调度流程
   * 事件监听
   * 业务流程状态
   * 调度与编排
   * 边界：不包含任何 HTML 字符串的拼接或具体的 CSS/DOM 操作细节。
