# 动态等宽 Tab 验收

环境：2026-10-17，127.0.0.1:5173 可变 GUI demo，用户原有 IAB 标签。为响应布局验收临时设置1200／900／700 ×827视口，结束已清除覆盖并恢复暗色；不操作正式 Desktop。

## 测量与交互

[15组实际测量](width-cases.json)覆盖窗口尺寸、侧栏开关／调宽、会话增删、右栏增删和 PA 空／单项右栏。浏览器只读 DOM 获取宽度、数量、滚动与顺序；[11项断言](checks.json)均通过。逐组按可见宽度与数量核算 clamp(96, (可用宽度−间隙)/数量, 180)，容忍浏览器1/64px布局取整，误差均小于0.05px。

900px窗口的静态会话区318px、3项各103.328125px；关闭一项后2项各157px。右栏可见229px时2项各112.5px，新增第三项后均为96px、scrollWidth296大于clientWidth229。右栏调宽64px后2项各144.5px；左栏收起后会话项扩大为160px。宽窗口触及180px上限，700px窗口两组触及96px下限且保留横滚。PA 空右栏数量变量钳为1而没有虚构标签，新增一项后宽180px。

[小数宽主栏向后拖动](fractional-main-forward-final.json)记录相邻项 shift=-1、源位移2槽且松手后提交；[反向拖动](fractional-main-reverse.json)恢复原顺序；[右栏小数宽拖动](fractional-right-reverse.json)记录112.5px下的预览与排序。每组原DOM顺序在预览期间保持，结束偏移清空。[溢出后拖动](overflow-main.json)在主栏scrollLeft108时正确移到第二位，[取消](responsive-cancel.json)保持原序并清理预览。空／单项及返回Code后，原右栏顺序和活动页面保持。原键盘及身份保护接线未更改，沿用上一轮证据。

[暗色](dark.png)、[浅色](light.png)为900px实际界面；[拖动帧](drag-fractional-dark.png)展示收缩标签的避让，[默认视口最终界面](final-dark.png)及[完整AX](final-state.txt)为收尾状态。fractional-main-forward.json是带截图的初次采样，只采到中间落点；最终无截图采样补齐2槽预览后再断言，不把稀疏采样误作功能失败。截图不包含系统原生拖影。

## 工程检查与限度

实施者运行 demo check（类型、render自检、Vite构建）、check:static和diff检查，全部通过；仍有原有大于500kB单块的构建提示。自检新增两组各自数量的接线断言；初版错误假设style仅有数量变量，已按Radix保留outline的实际输出改为分号属性匹配。独立审查与结论归[工单16](../../issues/16-responsive-tab-width.md)。控制台无error／warn。

本轮没有新增宽度过渡，拖动步长直接跟随当前布局；沿用系统减弱动画规则，未切换系统偏好实测。未验证正式Desktop／其他浏览器内核、触屏、跨窗或长期静止拖动，不作为通过项；宽度上下限观感留拥有者审阅。没有提交或同步生产界面。
