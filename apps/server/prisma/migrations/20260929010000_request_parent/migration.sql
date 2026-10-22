-- CLO-20 재위임: 하위 요청이 어느 요청(차수)에서 나왔는지와, 그때 넘겨받은 맥락 스냅샷
ALTER TABLE `Request` ADD COLUMN `parentRequestId` VARCHAR(191) NULL,
    ADD COLUMN `parentRevisionNo` INTEGER NULL,
    ADD COLUMN `parentContext` JSON NULL;

CREATE INDEX `Request_parentRequestId_idx` ON `Request`(`parentRequestId`);

ALTER TABLE `Request` ADD CONSTRAINT `Request_parentRequestId_fkey` FOREIGN KEY (`parentRequestId`) REFERENCES `Request`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
