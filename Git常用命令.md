```bash
 1. 克隆仓库（首次）
git clone https://github.com/StillRunDeep/PumpStation.git #默认
git clone git@github.com:StillRunDeep/PumpStation.git #ssh方式

 2. 创建功能分支
git switch -c feature/your-feature-name

 3.1 开始工作前，同步 main 最新内容
#执行一次即可，提前配置设置 git pull 时默认rebase
#git config --global pull.rebase true 
git pull origin main 

 3.2 开发、提交
git add . && git commit -m "feat: 添加某功能"

 3.3 推送到远端（日常备份 / 或为了让Claude可以选中并快速工作）
git push -u origin feature/name

 3.4 发起 PR 前，再次同步最新 main
git pull origin main 
git push --force-with-lease origin feature/【name】  

 4. GitHub 网页发起 Pull Request

 5. 团队 Review，按反馈修改，push 更新 PR

 6. 通过后合并到 main

 7. 清理旧分支
git push origin --delete feature/your-feature-name #删除远程
git branch -d feature/your-feature-name #继续开发到功能迭代更完善后再删

 8. 开发下一个 feature
git switch -c feature/name2

 9.使用以下命令查看简化的提交历史
# 找到你想回到的那个 commit 的 哈希值 (Hash)
git log --oneline --graph --decorate
# 这种方式会保留你之后的代码修改，但移除了提交记录
git reset --soft <commit-hash>
# 或者，这种方式会彻底删除之后的提交，且丢失工作区改动（慎用！）
git reset --hard <commit-hash>
```

