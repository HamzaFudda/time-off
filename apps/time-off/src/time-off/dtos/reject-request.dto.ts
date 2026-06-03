import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class RejectRequestDto {
  @ApiProperty({
    description: 'ID of the manager rejecting this request',
    example: 'mgr-456',
  })
  @IsString()
  @IsNotEmpty()
  managerId!: string;

  @ApiProperty({
    description: 'Optional rejection reason to surface to the employee',
    required: false,
  })
  @IsString()
  @IsOptional()
  reason?: string;
}
